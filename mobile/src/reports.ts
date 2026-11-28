import { verifiedOwnerToken, checkInVisit, checkOutVisit, createOrder, pushLocations, sendDailyReport, sendReport, type CheckOutBody } from './api';
import { createQueue, type Outbox } from './queue';
import { replayLocationOutbox } from './locationQueue';
import { replayOutboxActions } from './outboxReplay';
import { outboxOwnership } from './outboxOwnership';
import { createOutboxRunner } from './outboxRunner';
import { deliverOrderSafely, type OrderDelivery } from './orderDelivery';
import { getActiveUserId, getOutboxOwner, getGpsSaveWarning, setGpsSaveWarning, setActiveUserId } from './storage';
import type { DailyReportInput, GeoPoint, OutboxItem, ReportInput, VisitInput } from './types';

let queuePromise: Promise<Outbox> | null = null;
let activeUserId: string | null = null;
const outbox = () => (queuePromise ??= createQueue());

/**
 * The outbox is shared by the installation, not by the signed-in account. Remember which account
 * owns its pending rows so a session expiry followed by another engineer's login cannot upload the
 * first engineer's reports under the second engineer's name.
 */
export async function activateOutboxUser(userId: string): Promise<void> {
  activeUserId = userId;
  await setActiveUserId(userId);
  await outbox();
}
export async function deactivateOutboxUser(): Promise<void> {
  activeUserId = null;
  await setActiveUserId(null);
}

async function ownerForCurrentSession(): Promise<string | null> {
  return activeUserId ?? await getActiveUserId();
}
async function addOutboxItem(kind: OutboxItem['kind'], payload: unknown, requestedOwnerId?: string): Promise<void> {
  const queue = await outbox();
  const ownerId = requestedOwnerId ?? await ownerForCurrentSession();
  if (!ownerId) throw new Error('انتهت الجلسة؛ سجّل الدخول من جديد قبل حفظ بيانات للمزامنة.');
  await queue.addOwned(kind, payload, ownerId, await getOutboxOwner());
}

// Keep a warning even after space becomes available: the failed fix cannot be reconstructed.
// Memory is a fallback if even the separate warning store cannot be written.
let gpsSaveFailure = false;
export async function hasGpsSaveFailure(): Promise<boolean> { return gpsSaveFailure || (await getGpsSaveWarning()) === '1'; }
export async function acknowledgeGpsSaveFailure(): Promise<void> { gpsSaveFailure = false; await setGpsSaveWarning(null); }
/** Locations are batched so one offline flap does not create a burst of requests. */
export async function enqueueLocation(point: GeoPoint) {
  try { await addOutboxItem('location', point); }
  catch (error) { gpsSaveFailure = true; await setGpsSaveWarning('1'); throw error; }
}
export async function enqueueReport(report: ReportInput, userId?: string) { await addOutboxItem('report', report, userId); }
export async function enqueueDailyReport(report: DailyReportInput, userId?: string) { await addOutboxItem('daily-report', report, userId); }
/**
 * A visit typed in a field with no signal. It is queued with the moment it happened, because by
 * the time the phone gets a bar the server's clock no longer says anything true about it.
 */
export async function enqueueVisitCheckIn(visit: VisitInput & { recordedAt: number }, userId?: string) { await addOutboxItem('visit-checkin', visit, userId); }
export async function enqueueVisitCheckOut(visitId: string, body: CheckOutBody & { recordedAt: number }, userId?: string) {
  // The `id` is the queue key only; it is never part of the body the server sees.
  await addOutboxItem('visit-checkout', { id: `checkout:${visitId}`, visitId, body }, userId);
}
/**
 * An order agreed in a yard with two bars of signal. It carries its own uuid from the start — the
 * server treats a replay of that id as the same order — so retrying a send can never double a
 * quantity the office already priced.
 */
export async function enqueueOrder(order: import('./types').OrderInput & { recordedAt: number }, userId?: string) {
  await addOutboxItem('order', order, userId);
}

/** Account erasure must never clear a different account's pending work. */
export async function clearOutboxForDeletedUser(userId: string): Promise<boolean> {
  return (await outbox()).clearOwned(userId, await getOutboxOwner());
}

/** Fast local ownership check used before opening or resuming a shift; it does no network work. */
export async function outboxOwnerStatus(userId: string | null): Promise<{ blockedByOwner: boolean; notice?: string }> {
  const queue = await outbox();
  const ownership = outboxOwnership(await queue.owner(await getOutboxOwner()), userId, await queue.count());
  return ownership.allowed ? { blockedByOwner: false } : { blockedByOwner: true, notice: ownership.notice };
}

/** Local visits remain actionable until their start and result have reached the server. */
export async function queuedVisitState(userId: string): Promise<{ starts: Array<VisitInput & {recordedAt:number}>; finished: string[] }> {
  const queue = await outbox();
  const snapshot = await queue.snapshot(await getOutboxOwner(), 0);
  if (!outboxOwnership(snapshot.owner, userId, snapshot.count).allowed) return { starts: [], finished: [] };
  const items = snapshot.items;
  const starts: Array<VisitInput & {recordedAt:number}> = [], finished: string[] = [];
  for (const item of items) {
    try {
      const value = JSON.parse(item.payload);
      if (item.kind === 'visit-checkin' && value && typeof value.id === 'string' && typeof value.customerId === 'string' && value.location && typeof value.recordedAt === 'number') starts.push(value);
      if (item.kind === 'visit-checkout' && typeof value?.visitId === 'string') finished.push(value.visitId);
    } catch { /* replay reports the corrupt row and leaves it untouched */ }
  }
  return { starts, finished };
}

/**
 * `notice` carries a message the engineer has to act on (today: the phone clock is ahead, so
 * the server refuses every fix). It is not an error of ours — nothing is lost — so the caller
 * shows it and keeps the queue intact instead of splitting and dropping the batches.
 */
export interface FlushResult {
  sent: number; pending: number; pendingVisits: number; pendingOrders: number; notice?: string;
  /** A non-empty queue belongs to another account (or has no recoverable owner). */
  blockedByOwner?: boolean;
}

const runOutbox = createOutboxRunner<FlushResult | OrderDelivery>();

/** Serialize the initial attempt with replays so they cannot remove each other's queued record. */
export function sendOrderWithOutbox(order: import('./types').OrderInput, userId?: string): Promise<OrderDelivery> {
  return runOutbox(`order:${order.id}`, async () => {
    const queue = await outbox();
    return deliverOrderSafely(order, {
      save: async payload => {
        await enqueueOrder(payload, userId);
      },
      send: async payload => {
        // A visit created offline needs to reach the server before an order referencing it.
        if (payload.visitId && (await queue.listForReplay(0)).some(item => {
          if (item.kind !== 'visit-checkin') return false;
          try { const value = JSON.parse(item.payload); return !value || typeof value.id !== 'string' || !value.id.trim() || value.id === payload.visitId; } catch { return true; }
        })) {
          throw Object.assign(new Error('الزيارة لم تتزامن بعد'), { status: 0 });
        }
        const owner = userId ?? await ownerForCurrentSession();
        if (!owner) throw Object.assign(new Error('سجّل الدخول بالحساب صاحب الطلبية.'), { status: 401 });
        const token = await verifiedOwnerToken(owner);
        return createOrder(payload, token);
      },
      remove: id => queue.remove(id),
    });
  }) as Promise<OrderDelivery>;
}

export function flushOutbox(userId?: string, options: { retryRejected?: boolean } = {}): Promise<FlushResult> {
  const key = `flush:${userId ?? activeUserId ?? 'background'}:${options.retryRejected ? 'manual' : 'automatic'}`;
  return runOutbox(key, () => flushOnce(userId, options.retryRejected === true)) as Promise<FlushResult>;
}

async function flushOnce(requestedUserId?: string, retryRejected = false): Promise<FlushResult> {
  const queue = await outbox();
  const snapshot = await queue.snapshot(await getOutboxOwner(), 200, retryRejected);
  const pendingBefore = snapshot.count;
  const userId = requestedUserId ?? await ownerForCurrentSession();
  if (pendingBefore === 0) {
    return { sent: 0, pending: 0, pendingVisits: 0, pendingOrders: 0 };
  }
  const savedOwner = snapshot.owner;
  const ownership = outboxOwnership(savedOwner, userId, pendingBefore);
  if (!ownership.allowed) {
    const pendingVisits = await queue.count('visit-checkin') + await queue.count('visit-checkout');
    const pendingOrders = await queue.count('order');
    return { sent: 0, pending: pendingBefore, pendingVisits, pendingOrders, notice: ownership.notice, blockedByOwner: true };
  }
  const items = snapshot.items;
  const token = await verifiedOwnerToken(userId!);
  const replay = await replayOutboxActions(items, queue, {
    checkIn: value => checkInVisit(value, token),
    checkOut: (id, value) => checkOutVisit(id, value, token),
    report: value => sendReport(value, token),
    dailyReport: value => sendDailyReport(value, token),
    createOrder: value => createOrder(value, token),
  }, { retryRejected });
  let sent = replay.sent;
  let notice = replay.notice;
  // Even old fixes may belong to a completed shift: let the server verify each one rather than
  // guessing from its age. Rejected points stay saved and do not starve newer points.
  try {
    sent += await replayLocationOutbox(items, queue, points => pushLocations(points, token));
  } catch (error) {
    // The clock is the engineer's to fix, and every fix in the queue is still good.
    if ((error as { code?: string }).code !== 'CLOCK_SKEW') throw error;
    const gpsNotice = (error as Error).message;
    notice = notice ? `${notice} ${gpsNotice}` : gpsNotice;
  }
  const rejectedLocations = await queue.countRejectedLocations();
  if (rejectedLocations) {
    const gpsNotice = `في ${rejectedLocations} نقطة موقع محفوظة على الهاتف لم يقبلها السيرفر أو تعذر قراءتها؛ قد يكون وقتها خارج الوردية أو مدة الاحتفاظ. المسار غير مكتمل. لا تمسح بيانات التطبيق، وراجع المكتب؛ يمكن إعادة المحاولة من «مزامنة الآن».`;
    notice = notice ? `${notice} ${gpsNotice}` : gpsNotice;
  }
  const pending = await queue.count();
  const pendingVisits = await queue.count('visit-checkin') + await queue.count('visit-checkout');
  const pendingOrders = await queue.count('order');
  return notice ? { sent, pending, pendingVisits, pendingOrders, notice } : { sent, pending, pendingVisits, pendingOrders };
}
