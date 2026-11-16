import { pushLocations, sendDailyReport, sendReport } from './api';
import { createQueue, type Outbox } from './queue';
import { sendLocationChunks } from './locationQueue';
import type { DailyReportInput, GeoPoint, ReportInput } from './types';

/** Matches the server's window: nothing older than this can still belong to a shift. */
const STALE_FIX_MS = 24 * 3600000;

let queuePromise: Promise<Outbox> | null = null;
const outbox = () => (queuePromise ??= createQueue());

/** Locations are batched so one offline flap does not create a burst of requests. */
export async function enqueueLocation(point: GeoPoint) { await (await outbox()).add('location', point); }
export async function enqueueReport(report: ReportInput) { await (await outbox()).add('report', report); }
export async function enqueueDailyReport(report: DailyReportInput) { await (await outbox()).add('daily-report', report); }

let flushing: Promise<{ sent: number; pending: number }> | null = null;
export function flushOutbox(): Promise<{ sent: number; pending: number }> {
  if (!flushing) flushing = flushOnce().finally(() => { flushing = null; });
  return flushing;
}

async function flushOnce(): Promise<{ sent: number; pending: number }> {
  const queue = await outbox();
  const items = await queue.list(200);
  let sent = 0;
  const locations: GeoPoint[] = [];
  for (const item of items) {
    try {
      if (item.kind === 'location') { locations.push(JSON.parse(item.payload) as GeoPoint); continue; }
      const payload = JSON.parse(item.payload) as ReportInput | DailyReportInput;
      if (item.kind === 'report') await sendReport(payload as ReportInput);
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
  sent += await sendLocationChunks(fresh, pushLocations, id => queue.remove(id));
  return { sent, pending: await queue.count() };
}
