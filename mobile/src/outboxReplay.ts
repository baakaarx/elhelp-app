import type { CheckOutBody } from './api';
import type { Outbox } from './queue';
import type { DailyReportInput, OrderInput, OutboxItem, ReportInput, VisitInput } from './types';

type QueuedCheckIn = VisitInput & { recordedAt: number };
type QueuedCheckOut = { id: string; visitId: string; body: CheckOutBody & { recordedAt: number } };
type QueuedOrder = OrderInput & { recordedAt: number };

export interface OutboxSenders {
  checkIn(visit: QueuedCheckIn): Promise<unknown>;
  checkOut(visitId: string, body: QueuedCheckOut['body']): Promise<unknown>;
  report(report: ReportInput): Promise<unknown>;
  dailyReport(report: DailyReportInput): Promise<unknown>;
  createOrder(order: QueuedOrder): Promise<unknown>;
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
  // Pre-populate before replay: device clock changes can put a dependent action before its
  // check-in in createdAt order. Only release the dependency after the check-in is confirmed.
  const checkInsToRetry = new Set<string>();
  for (const item of items) if (item.kind === 'visit-checkin') {
    try { const value = JSON.parse(item.payload); if (typeof value?.id === 'string' && value.id.trim()) checkInsToRetry.add(value.id); } catch { /* handled below */ }
  }
  // If any check-in cannot be identified, no visit-linked action is safe to send, even
  // when it appears earlier in the queue. Keep unrelated reports and orders moving.
  const unknownCheckIn = items.some(item => {
    if (item.kind !== 'visit-checkin') return false;
    try { const value = JSON.parse(item.payload); return !value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || !value.id.trim(); }
    catch { return true; }
  });
  for (const item of items) {
    if (item.kind === 'location') continue;
    let payload: unknown;
    try { payload = JSON.parse(item.payload); }
    catch {
      notice ||= 'تعذر قراءة بيانات محفوظة على الهاتف أو التأكد من وصولها. ابقَ داخل الحساب واطلب مساعدة؛ لا تحذف بيانات التطبيق.';
      continue;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || (item.kind === 'visit-checkin' && (typeof (payload as QueuedCheckIn).id !== 'string' || !(payload as QueuedCheckIn).id.trim()))) {
      notice ||= 'تعذر قراءة بيانات محفوظة على الهاتف أو التأكد من وصولها. ابقَ داخل الحساب واطلب مساعدة؛ لا تحذف بيانات التطبيق.';
      continue;
    }

    if (item.rejected && !options.retryRejected) {
      if (item.kind === 'visit-checkin') checkInsToRetry.add((payload as QueuedCheckIn).id);
      const oldFieldMoney = (item.kind === 'visit-checkout' && Number((payload as QueuedCheckOut).body?.amount) > 0)
        || (item.kind === 'report' && ((payload as ReportInput).type === 'collection' || Number((payload as ReportInput).amount) > 0));
      notice ||= oldFieldMoney
        ? 'بيانات تحصيل ميداني قديمة لم تُرسل وما زالت محفوظة على الهاتف، ولم تُخصم من حساب العميل. لا تحذف البيانات؛ راجع فريق المبيعات للدفع ومساعدة المكتب للبيانات المعلقة.'
        : 'هناك بيانات محفوظة رفضها السيرفر؛ ما زالت على الهاتف ولم نكرر إرسالها تلقائيًا. افتح «حسابي» واضغط «مزامنة الآن» لإعادة المحاولة.';
      continue;
    }
    if (item.kind === 'visit-checkout') {
      const checkout = payload as QueuedCheckOut;
      // A pending check-in must stay ahead of its dependent result.
      if (unknownCheckIn || checkInsToRetry.has(checkout.visitId)) continue;
    }
    if (item.kind === 'order') {
      const order = payload as QueuedOrder;
      // An order linked to an offline visit must wait for the visit to reach the server first.
      if (order.visitId && (unknownCheckIn || checkInsToRetry.has(order.visitId))) continue;
    }

    if (item.rejected && options.retryRejected) await queue.unreject(item.key);

    try {
      if (item.kind === 'visit-checkin') await send.checkIn(payload as QueuedCheckIn);
      else if (item.kind === 'visit-checkout') {
        const checkout = payload as QueuedCheckOut;
        await send.checkOut(checkout.visitId, checkout.body);
      } else if (item.kind === 'report') await send.report(payload as ReportInput);
      // Named, not fallen into: the last branch used to be «anything else», and a kind added without
      // a line here would have been silently replayed as a daily report.
      else if (item.kind === 'daily-report') await send.dailyReport(payload as DailyReportInput);
      else if (item.kind === 'order') await send.createOrder(payload as QueuedOrder);
      else {
        notice ||= 'في بيانات محفوظة من نسخة تانية من التطبيق؛ ما زالت على الهاتف ولم تُرسل. حدّث التطبيق أو اطلب مساعدة.';
        continue;
      }
      await queue.remove(item.key);
      if (item.kind === 'visit-checkin') checkInsToRetry.delete((payload as QueuedCheckIn).id);
      sent++;
    } catch (error) {
      const status = (error as { status?: number }).status ?? 0;
      await queue.bump(item.key);
      // A failed check-in of any kind blocks its dependent check-out for this pass. Even a
      // permanent rejection must not turn the result into a second, misleading 404 rejection.
      if (item.kind === 'visit-checkin') checkInsToRetry.add((payload as QueuedCheckIn).id);
      // A permanent rejection must not block other items, but it must not erase field work
      // either. Keep the payload on-device and surface the server's reason for manual follow-up.
      if (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) {
        await queue.reject(item.key);
        const detail = error instanceof Error ? error.message : `HTTP ${status}`;
        notice ||= `السيرفر لم يقبل بيانات محفوظة: ${detail} — البيانات ما زالت على الهاتف. راجعها، ثم أعد المحاولة يدويًا.`;
      }
      if ((error as { code?: string }).code === 'ORDER_CONFIRMATION_UNCERTAIN') {
        notice ||= 'تعذر التأكد من بيانات طلبية محفوظة عند المكتب. هي ما زالت على الهاتف؛ راجع المكتب ولا تكرر الطلبية.';
      }
      if ((error as { code?: string }).code === 'ACTION_CONFIRMATION_UNCERTAIN') {
        notice ||= 'تعذر التأكد من بيانات الزيارة أو التقرير عند المكتب. البيانات ما زالت على الهاتف؛ راجع المكتب ولا تكررها.';
      }
      if (status === 401) break;
    }
  }
  return notice ? { sent, notice } : { sent };
}
