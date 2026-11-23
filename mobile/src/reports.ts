import { checkInVisit, checkOutVisit, createMyInvoice, pushLocations, sendDailyReport, sendReport, type CheckOutBody } from './api';
import { createQueue, type Outbox } from './queue';
import { sendLocationChunks } from './locationQueue';
import { replayOutboxActions } from './outboxReplay';
import { outboxOwnership } from './outboxOwnership';
import { getActiveUserId, getOutboxOwner, setActiveUserId, setOutboxOwner } from './storage';
import type { DailyReportInput, GeoPoint, InvoiceInput, OutboxItem, ReportInput, VisitInput } from './types';

/** Matches the server's window: nothing older than this can still belong to a shift. */
const STALE_FIX_MS = 24 * 3600000;

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

/** Locations are batched so one offline flap does not create a burst of requests. */
export async function enqueueLocation(point: GeoPoint) { await addOutboxItem('location', point); }
export async function enqueueReport(report: ReportInput, userId?: string) { await addOutboxItem('report', report, userId); }
export async function enqueueDailyReport(report: DailyReportInput, userId?: string) { await addOutboxItem('daily-report', report, userId); }
/**
 * A visit typed in a field with no signal. It is queued with the moment it happened, because by
 * the time the phone gets a bar the server's clock no longer says anything true about it.
 */
export async function enqueueInvoice(invoice: InvoiceInput & { recordedAt: number }, userId?: string) {
  await addOutboxItem('invoice', invoice, userId);
}
export async function enqueueVisitCheckIn(visit: VisitInput & { recordedAt: number }, userId?: string) { await addOutboxItem('visit-checkin', visit, userId); }
export async function enqueueVisitCheckOut(visitId: string, body: CheckOutBody & { recordedAt: number }, userId?: string) {
  // The `id` is the queue key only; it is never part of the body the server sees.
  await addOutboxItem('visit-checkout', { id: `checkout:${visitId}`, visitId, body }, userId);
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
  sent: number; pending: number; pendingVisits: number; notice?: string;
  /** Sales typed without signal. They are the office's ledger, so this number is not decoration. */
  pendingInvoices?: number;
  /** A non-empty queue belongs to another account (or has no recoverable owner). */
  blockedByOwner?: boolean;
}

const flushing = new Map<string, Promise<FlushResult>>();
export function flushOutbox(userId?: string, options: { retryRejected?: boolean } = {}): Promise<FlushResult> {
  const key = `${userId ?? activeUserId ?? 'background'}:${options.retryRejected ? 'manual' : 'automatic'}`;
  const existing = flushing.get(key);
  if (existing) return existing;
  const task = flushOnce(userId, options.retryRejected === true).finally(() => { flushing.delete(key); });
  flushing.set(key, task);
  return task;
}

async function flushOnce(requestedUserId?: string, retryRejected = false): Promise<FlushResult> {
  const queue = await outbox();
  const pendingBefore = await queue.count();
  const userId = requestedUserId ?? await ownerForCurrentSession();
  if (pendingBefore === 0) {
    if (userId) await setOutboxOwner(userId);
    return { sent: 0, pending: 0, pendingVisits: 0 };
  }
  const savedOwner = await getOutboxOwner();
  const ownership = outboxOwnership(savedOwner, userId, pendingBefore);
  if (!ownership.allowed) {
    const pendingVisits = await queue.count('visit-checkin') + await queue.count('visit-checkout');
    return { sent: 0, pending: pendingBefore, pendingVisits, notice: ownership.notice, blockedByOwner: true };
  }
  const items = await queue.list(200);
  const replay = await replayOutboxActions(items, queue, {
    checkIn: checkInVisit,
    checkOut: checkOutVisit,
    report: sendReport,
    dailyReport: sendDailyReport,
    // A sale typed with no signal is replayed to the same endpoint, and `recordedAt` rides along
    // unread: the server stamps the invoice with its own clock.
    invoice: createMyInvoice,
  }, { retryRejected });
  let sent = replay.sent;
  let notice = replay.notice;
  const locations: GeoPoint[] = [];
  for (const item of items) {
    if (item.kind !== 'location') continue;
    // Parsed separately: a truncated payload is not a network error, and bumping it would keep
    // the same dead row at the head of the queue for the life of the install.
    try { locations.push(JSON.parse(item.payload) as GeoPoint); }
    catch { await queue.remove(item.key); }
  }
  /*
   * A fix older than a day cannot belong to any open shift (the server closes a shift that has
   * been silent for 18 hours), so it would only ever be rejected. Dropping it here matters:
   * a rejected batch is split in half until every point fails, which is ~128 requests for a
   * single stale backlog of 80 points — every time the app came back online.
   */
  const cutoff = Date.now() - STALE_FIX_MS;
  const fresh: GeoPoint[] = [];
  for (const point of locations) {
    if (point.recordedAt >= cutoff) fresh.push(point);
    else await queue.remove(point.id);
  }
  // Preserve unsent fixes on transient errors and isolate invalid points.
  try {
    sent += await sendLocationChunks(fresh, pushLocations, id => queue.remove(id));
  } catch (error) {
    // The clock is the engineer's to fix, and every fix in the queue is still good.
    if ((error as { code?: string }).code !== 'CLOCK_SKEW') throw error;
    const gpsNotice = (error as Error).message;
    notice = notice ? `${notice} ${gpsNotice}` : gpsNotice;
  }
  const pending = await queue.count();
  const pendingVisits = await queue.count('visit-checkin') + await queue.count('visit-checkout');
  const pendingInvoices = await queue.count('invoice');
  if (pending === 0) await setOutboxOwner(userId);
  return notice ? { sent, pending, pendingVisits, pendingInvoices, notice } : { sent, pending, pendingVisits, pendingInvoices };
}
