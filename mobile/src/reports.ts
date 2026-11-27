import { checkInVisit, checkOutVisit, createOrder, pushLocations, sendDailyReport, sendReport, type CheckOutBody } from './api';
import { createQueue, type Outbox } from './queue';
import { replayLocationOutbox } from './locationQueue';
import { replayOutboxActions } from './outboxReplay';
import { outboxOwnership } from './outboxOwnership';
import { createOutboxRunner } from './outboxRunner';
import { deliverOrderSafely, type OrderDelivery } from './orderDelivery';
import { getActiveUserId, getOutboxOwner, getGpsSaveWarning, setGpsSaveWarning, setActiveUserId, setOutboxOwner } from './storage';
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
  const queue = await outbox();
  if (await queue.count() === 0) await setOutboxOwner(userId);
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
  const count = await queue.count();
  const savedOwner = await getOutboxOwner();
  const ownership = outboxOwnership(savedOwner, ownerId, count);
  if (!ownership.allowed) {
    throw new Error(`${ownership.notice || 'لا يمكن إضافة البيانات إلى قائمة المزامنة الحالية.'} لم يُحفظ الطلب الجديد.`);
  }
  if (count === 0) {
    await setOutboxOwner(ownerId);
    if (await getOutboxOwner() !== ownerId) throw new Error('تعذر تسجيل ملكية البيانات المحفوظة على هذا الهاتف؛ لم نحفظ الطلب.');
  }
  await queue.add(kind, payload);
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

/** Clear only after the engineer confirms pending work should be discarded. */
export async function clearOutbox(): Promise<void> {
  activeUserId = null;
  await (await outbox()).clear();
  await Promise.all([setOutboxOwner(null), setActiveUserId(null)]);
}

/** Fast local ownership check used before opening or resuming a shift; it does no network work. */
export async function outboxOwnerStatus(userId: string | null): Promise<{ blockedByOwner: boolean; notice?: string }> {
  const queue = await outbox();
  const ownership = outboxOwnership(await getOutboxOwner(), userId, await queue.count());
  return ownership.allowed ? { blockedByOwner: false } : { blockedByOwner: true, notice: ownership.notice };
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
        if (payload.visitId && (await queue.listForReplay(0)).some(item => item.kind === 'visit-checkin' && item.key === payload.visitId)) {
          throw Object.assign(new Error('الزيارة لم تتزامن بعد'), { status: 0 });
        }
        return createOrder(payload);
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
  const pendingBefore = await queue.count();
  const userId = requestedUserId ?? await ownerForCurrentSession();
  if (pendingBefore === 0) {
    if (userId) await setOutboxOwner(userId);
    return { sent: 0, pending: 0, pendingVisits: 0, pendingOrders: 0 };
  }
  const savedOwner = await getOutboxOwner();
  const ownership = outboxOwnership(savedOwner, userId, pendingBefore);
  if (!ownership.allowed) {
    const pendingVisits = await queue.count('visit-checkin') + await queue.count('visit-checkout');
    const pendingOrders = await queue.count('order');
    return { sent: 0, pending: pendingBefore, pendingVisits, pendingOrders, notice: ownership.notice, blockedByOwner: true };
  }
  const items = await queue.listForReplay(200, retryRejected);
  const replay = await replayOutboxActions(items, queue, {
    checkIn: checkInVisit,
    checkOut: checkOutVisit,
    report: sendReport,
    dailyReport: sendDailyReport,
    createOrder,
  }, { retryRejected });
  let sent = replay.sent;
  let notice = replay.notice;
  // Even old fixes may belong to a completed shift: let the server verify each one rather than
  // guessing from its age. Rejected points stay saved and do not starve newer points.
  try {
    sent += await replayLocationOutbox(items, queue, pushLocations);
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
  if (pending === 0) await setOutboxOwner(userId);
  return notice ? { sent, pending, pendingVisits, pendingOrders, notice } : { sent, pending, pendingVisits, pendingOrders };
}
