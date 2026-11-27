import type { OrderInput } from './types';

export type OrderDelivery = { status: 'sent' } | { status: 'queued'; reason: 'connection' | 'session' | 'storage' | 'confirmation' };

/** Save the exact action before any network request, then remove it only after a verified reply. */
export async function deliverOrderSafely(
  order: OrderInput,
  ops: { save(order: OrderInput & { recordedAt: number }): Promise<void>; send(order: OrderInput): Promise<unknown>; remove(id: string): Promise<void> },
  now = Date.now(),
): Promise<OrderDelivery> {
  await ops.save({ ...order, recordedAt: now });
  try {
    await ops.send(order);
  } catch (error) {
    const status = (error as { status?: number } | null)?.status ?? 0;
    if ((error as { code?: string } | null)?.code === 'ORDER_CONFIRMATION_UNCERTAIN') return { status: 'queued', reason: 'confirmation' };
    // A lost response, timeout or gateway failure may follow a successful server commit. Keep
    // the same id; a new order would be a second agreement, not a retry.
    if (status === 0 || status === 408 || status === 429 || status >= 500) return { status: 'queued', reason: 'connection' };
    if (status === 401) return { status: 'queued', reason: 'session' };
    // A definitive validation/permission rejection was not committed. If removal fails, do not
    // invite a second submit while a copy remains in storage; keep it for manual follow-up.
    try { await ops.remove(order.id); }
    catch { return { status: 'queued', reason: 'storage' }; }
    throw error;
  }
  try { await ops.remove(order.id); }
  catch { return { status: 'queued', reason: 'storage' }; }
  return { status: 'sent' };
}

/** An HTTP 200 without the actual matching order is not confirmation of delivery. */
export function isConfirmedOrderResponse(input: OrderInput, response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const payload = response as { order?: { id?: unknown; customerId?: unknown; status?: unknown; notes?: unknown; lines?: unknown }; duplicate?: unknown };
  const order = payload.order;
  if (!order || order.id !== input.id || order.customerId !== input.customerId || typeof payload.duplicate !== 'boolean') return false;
  if (input.send !== false && order.status !== 'sent' && order.status !== 'priced') return false;
  if (order.notes !== input.notes.trim() || !Array.isArray(order.lines) || order.lines.length !== input.lines.length) return false;
  const savedLines = order.lines as Array<{ productId?: unknown; qty?: unknown; notes?: unknown }>;
  return input.lines.every((line, index) => {
    const saved = savedLines[index];
    return !!saved && saved.productId === line.productId && saved.qty === line.qty && saved.notes === (line.notes ?? '').trim();
  });
}
