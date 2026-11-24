import type { CheckOutBody } from './api';
import type { Outbox } from './queue';
import type { DailyReportInput, OutboxItem, ReportInput, VisitInput } from './types';

type QueuedCheckIn = VisitInput & { recordedAt: number };
type QueuedCheckOut = { id: string; visitId: string; body: CheckOutBody & { recordedAt: number } };

export interface OutboxSenders {
  checkIn(visit: QueuedCheckIn): Promise<unknown>;
  checkOut(visitId: string, body: QueuedCheckOut['body']): Promise<unknown>;
  report(report: ReportInput): Promise<unknown>;
  dailyReport(report: DailyReportInput): Promise<unknown>;
}

export interface OutboxReplayResult { sent: number; notice?: string }

/** Replay the non-GPS actions while preserving the check-in → check-out dependency. */
export async function replayOutboxActions(
  items: OutboxItem[],
  queue: Pick<Outbox, 'remove' | 'bump' | 'reject' | 'unreject'>,
  send: OutboxSenders,
  options: { retryRejected?: boolean } = {},
): Promise<OutboxReplayResult> {
  let sent = 0;
  let notice: string | undefined;
  const checkInsToRetry = new Set<string>();
  for (const item of items) {
    if (item.kind === 'location') continue;
    let payload: unknown;
    try { payload = JSON.parse(item.payload); }
    catch {
      notice ||= 'تعذر قراءة عنصر محفوظ على الهاتف؛ ما زال محفوظًا ولم يُرسل. ابقَ داخل الحساب واطلب مساعدة قبل حذف البيانات المعلقة.';
      continue;
    }

    if (item.rejected && !options.retryRejected) {
      if (item.kind === 'visit-checkin') checkInsToRetry.add((payload as QueuedCheckIn).id);
      notice ||= 'هناك بيانات محفوظة رفضها السيرفر؛ ما زالت على الهاتف ولم نكرر إرسالها تلقائيًا. افتح «مزامنة ما لم يُرسل» لإعادة المحاولة.';
      continue;
    }
    if (item.rejected && options.retryRejected) await queue.unreject(item.key);

    if (item.kind === 'visit-checkout') {
      const checkout = payload as QueuedCheckOut;
      // A check-in that is pending or paused after rejection must stay ahead of its result;
      // otherwise a 404 from the check-out would create a second, misleading permanent failure.
      if (checkInsToRetry.has(checkout.visitId)) continue;
    }

    try {
      if (item.kind === 'visit-checkin') await send.checkIn(payload as QueuedCheckIn);
      else if (item.kind === 'visit-checkout') {
        const checkout = payload as QueuedCheckOut;
        await send.checkOut(checkout.visitId, checkout.body);
      } else if (item.kind === 'report') await send.report(payload as ReportInput);
      else await send.dailyReport(payload as DailyReportInput);
      await queue.remove(item.key);
      sent++;
    } catch (error) {
      const status = (error as { status?: number }).status ?? 0;
      await queue.bump(item.key);
      // A failed check-in of any kind blocks its dependent check-out for this pass. Even a
      // permanent rejection must not turn the result into a second, misleading 404 rejection.
      if (item.kind === 'visit-checkin') checkInsToRetry.add((payload as QueuedCheckIn).id);
      // A permanent rejection must not block other items, but it must not erase field work
      // either. Keep the payload on-device and surface the server's reason for manual follow-up.
      if (status >= 400 && status < 500 && status !== 401 && status !== 429) {
        await queue.reject(item.key);
        const detail = error instanceof Error ? error.message : `HTTP ${status}`;
        notice ||= `السيرفر لم يقبل بيانات محفوظة: ${detail} — البيانات ما زالت على الهاتف. راجعها، ثم أعد المحاولة يدويًا.`;
      }
      if (status === 401) break;
    }
  }
  return notice ? { sent, notice } : { sent };
}
