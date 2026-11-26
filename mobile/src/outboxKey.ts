/**
 * The key an outbox item is stored under.
 *
 * It used to be read straight off `payload.id`, which quietly broke the moment someone queued a
 * payload without one: the web queue compares keys to avoid duplicates, so two different
 * check-outs looked like the same item and the second was dropped, and the native queue inserted
 * a row with no key at all. Callers still pass an `id` when they have one; anything else gets a
 * unique key so nothing is ever merged or lost.
 */
export function outboxKey(kind: string, payload: unknown): string {
  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id === 'string' && id.trim()) return id;
  return `${kind}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

/** Never report a second, different action as queued merely because its key already exists. */
export function assertSameQueuedAction(existing: { kind: string; payload: string }, kind: string, payload: string): void {
  if (existing.kind !== kind || existing.payload !== payload) {
    throw new Error('في بيانات مختلفة محفوظة بنفس المعرّف؛ الطلب الجديد لم يُحفظ. راجع البيانات المعلقة واطلب المساعدة قبل المحاولة.');
  }
}
