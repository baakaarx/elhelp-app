import { checkInVisit, checkOutVisit, pushLocations, sendDailyReport, sendReport, type CheckOutBody } from './api';
import { createQueue, type Outbox } from './queue';
import { sendLocationChunks } from './locationQueue';
import type { DailyReportInput, GeoPoint, ReportInput, VisitInput } from './types';

/** Matches the server's window: nothing older than this can still belong to a shift. */
const STALE_FIX_MS = 24 * 3600000;

let queuePromise: Promise<Outbox> | null = null;
const outbox = () => (queuePromise ??= createQueue());

/** Locations are batched so one offline flap does not create a burst of requests. */
export async function enqueueLocation(point: GeoPoint) { await (await outbox()).add('location', point); }
export async function enqueueReport(report: ReportInput) { await (await outbox()).add('report', report); }
export async function enqueueDailyReport(report: DailyReportInput) { await (await outbox()).add('daily-report', report); }
/**
 * A visit typed in a field with no signal. It is queued with the moment it happened, because by
 * the time the phone gets a bar the server's clock no longer says anything true about it.
 */
export async function enqueueVisitCheckIn(visit: VisitInput & { recordedAt: number }) { await (await outbox()).add('visit-checkin', visit); }
export async function enqueueVisitCheckOut(visitId: string, body: CheckOutBody & { recordedAt: number }) {
  // The `id` is the queue key only; it is never part of the body the server sees.
  await (await outbox()).add('visit-checkout', { id: `checkout:${visitId}`, visitId, body });
}

/**
 * `notice` carries a message the engineer has to act on (today: the phone clock is ahead, so
 * the server refuses every fix). It is not an error of ours — nothing is lost — so the caller
 * shows it and keeps the queue intact instead of splitting and dropping the batches.
 */
export interface FlushResult { sent: number; pending: number; notice?: string }

let flushing: Promise<FlushResult> | null = null;
export function flushOutbox(): Promise<FlushResult> {
  if (!flushing) flushing = flushOnce().finally(() => { flushing = null; });
  return flushing;
}

async function flushOnce(): Promise<FlushResult> {
  const queue = await outbox();
  const items = await queue.list(200);
  let sent = 0;
  const locations: GeoPoint[] = [];
  for (const item of items) {
    try {
      // Parsed separately: a truncated payload is not a network error, and bumping it would
      // keep the same dead row at the head of the queue for the life of the install.
      let payload: GeoPoint | ReportInput | DailyReportInput | (VisitInput & { recordedAt: number }) | { id: string; visitId: string; body: CheckOutBody & { recordedAt: number } };
      try { payload = JSON.parse(item.payload); }
      catch { await queue.remove(item.key); continue; }
      if (item.kind === 'location') { locations.push(payload as GeoPoint); continue; }
      if (item.kind === 'visit-checkin') await checkInVisit(payload as VisitInput & { recordedAt: number });
      else if (item.kind === 'visit-checkout') {
        const queued = payload as { id: string; visitId: string; body: CheckOutBody };
        await checkOutVisit(queued.visitId, queued.body);
      }
      else if (item.kind === 'report') await sendReport(payload as ReportInput);
      else await sendDailyReport(payload as DailyReportInput);
      await queue.remove(item.key);
      sent++;
    } catch (error) {
      const status = (error as { status?: number }).status ?? 0;
      await queue.bump(item.key);
      // Permanent validation errors are dropped instead of blocking the queue forever.
      if (status >= 400 && status < 500 && status !== 401 && status !== 429) await queue.remove(item.key);
      if (status === 401) break;
    }
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
  let notice: string | undefined;
  try {
    sent += await sendLocationChunks(fresh, pushLocations, id => queue.remove(id));
  } catch (error) {
    // The clock is the engineer's to fix, and every fix in the queue is still good.
    if ((error as { code?: string }).code !== 'CLOCK_SKEW') throw error;
    notice = (error as Error).message;
  }
  const pending = await queue.count();
  return notice ? { sent, pending, notice } : { sent, pending };
}
