import type { Store } from '../../db.js';
import { listDailyReports } from '../../dailyReports.js';

export interface ReviewItem {
  id: string;
  engineerName: string;
  repName: string;
  reportDate: string;
  status: string;
  visitsCount: number;
  score: 'مكتمل' | 'جيد' | 'ناقص' | 'يحتاج متابعة';
  issues: string[];
  suggestions: string[];
}

export function reviewDailyReports(store: Store, opts: { limit?: number } = {}) {
  const reports = listDailyReports(store, {}).filter(r => r.status === 'new').slice(0, opts.limit ?? 20);

  const items: ReviewItem[] = reports.map(r => {
    const issues: string[] = [];
    const suggestions: string[] = [];

    if (!r.leftAt || !r.returnedAt) {
      issues.push('وقت الخروج/العودة غير مكتمل');
      suggestions.push('اطلب من المهندس تسجيل وقت الخروج والعودة بدقة');
    }
    if (r.leftAt && r.returnedAt && r.leftAt > r.returnedAt) {
      issues.push(`وقت الخروج (${r.leftAt}) بعد وقت العودة (${r.returnedAt})`);
    }
    const emptyOutcome = r.visits.filter(v => !v.outcome?.trim()).length;
    const emptyRec = r.visits.filter(v => !v.recommendations?.trim()).length;
    if (emptyOutcome > r.visits.length / 2) {
      issues.push(`${emptyOutcome} من ${r.visits.length} زيارات بدون نتيجة واضحة`);
      suggestions.push('اطلب توضيح نتائج الزيارات');
    }
    if (emptyRec > r.visits.length / 2) {
      issues.push(`${emptyRec} زيارات بدون توصيات`);
    }
    if (r.visits.length === 0) {
      issues.push('التقرير بدون زيارات');
      suggestions.push('التقرير الفارغ يُرفض — اطلب إعادة الإرسال مع زيارة واحدة على الأقل');
    }
    if (r.visits.length > 0 && r.visits.length < 2) {
      suggestions.push('عدد زيارات قليل — هل واجه المهندس صعوبة ميدانية؟');
    }

    let score: ReviewItem['score'] = 'مكتمل';
    if (issues.length === 0) score = 'مكتمل';
    else if (issues.length === 1) score = 'جيد';
    else if (issues.length === 2) score = 'ناقص';
    else score = 'يحتاج متابعة';

    return {
      id: r.id,
      engineerName: r.engineerName,
      repName: r.repName,
      reportDate: r.reportDate,
      status: r.status,
      visitsCount: r.visits.length,
      score,
      issues,
      suggestions,
    };
  });

  const summary = items.length === 0
    ? 'لا توجد تقارير يومية معلقة للمراجعة — كل التقارير تم اعتمادها.'
    : `تمت مراجعة ${items.length} تقرير معلق: ${items.filter(i => i.score === 'مكتمل').length} مكتمل، ${items.filter(i => i.score === 'ناقص' || i.score === 'يحتاج متابعة').length} يحتاج متابعة.`;

  return {
    summary,
    details: { totalPending: items.length, items },
    suggestions: items.flatMap(i => i.suggestions).slice(0, 5),
  };
}
