import { pushLocations, sendDailyReport, sendReport } from './api';
import { createQueue, type Outbox } from './queue';
import type { DailyReportInput, GeoPoint, ReportInput } from './types';

let queuePromise: Promise<Outbox> | null = null;
const outbox = () => (queuePromise ??= createQueue());

/** Locations are batched so one offline flap does not create a burst of requests. */
export async function enqueueLocation(point: GeoPoint) { await (await outbox()).add('location', point); }
export async function enqueueReport(report: ReportInput) { await (await outbox()).add('report', report); }
export async function enqueueDailyReport(report: DailyReportInput) { await (await outbox()).add('daily-report', report); }

export async function flushOutbox(): Promise<{ sent: number; pending: number }> {
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
  if (locations.length) {
    try {
      let accepted = 0;
      for (let i = 0; i < locations.length; i += 80) {
        const chunk = locations.slice(i, i + 80);
        await pushLocations(chunk);
        accepted += chunk.length;
      }
      for (const point of locations) await queue.remove(point.id);
      sent += accepted;
    } catch (error) {
      if (((error as { status?: number }).status ?? 0) >= 400) {
        for (const point of locations) await queue.remove(point.id);
      }
    }
  }
  return { sent, pending: await queue.count() };
}
