import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces.js';
import type { DailyReport } from './dailyReports.js';

const require = createRequire(import.meta.url);
// pdfmake 0.2 exposes a synchronous printer; keep the dependency server-side only.
const PdfPrinter = require('pdfmake') as new (fonts: Record<string, Record<string, string>>) => {
  createPdfKitDocument(doc: TDocumentDefinitions): NodeJS.ReadableStream & { end(): void };
};
const fontkit = require('@foliojs-fork/fontkit') as { openSync(path: string): { unitsPerEm: number; layout(text: string): { advanceWidth: number } } };
const fontRoot = join(dirname(require.resolve('@expo-google-fonts/noto-naskh-arabic/package.json')));
const fontPaths = {
  normal: join(fontRoot, '400Regular/NotoNaskhArabic_400Regular.ttf'),
  bold: join(fontRoot, '700Bold/NotoNaskhArabic_700Bold.ttf'),
  italics: join(fontRoot, '400Regular/NotoNaskhArabic_400Regular.ttf'),
  bolditalics: join(fontRoot, '700Bold/NotoNaskhArabic_700Bold.ttf'),
};
const printer = new PdfPrinter({ Naskh: fontPaths });
const measured = { normal: fontkit.openSync(fontPaths.normal), bold: fontkit.openSync(fontPaths.bold) };

// PDFKit can collapse ordinary spaces between Arabic words. We measure words with
// the same font, wrap explicitly, then join each line with non-breaking spaces.
// The logical Arabic string is passed through unchanged; pre-reversing it with a
// bidi library would double-reverse the glyphs.
function wrapText(value: string | number | null | undefined, maxWidth: number, fontSize = 9, bold = false): string {
  const words = String(value ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const font = bold ? measured.bold : measured.normal;
  const width = (text: string) => font.layout(text).advanceWidth / font.unitsPerEm * fontSize;
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (width(candidate) <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines.map(text => text.replace(/ /g, '\u00a0')).join('\n');
}
const cell = (value: string | number | null | undefined, width: number, opts: Record<string, unknown> = {}): Content => ({
  text: wrapText(value, width - 8, Number(opts.fontSize || 9), !!opts.bold) || '—', alignment: 'right', ...opts,
});
const head = (value: string, width: number, opts: Record<string, unknown> = {}): Content => cell(value, width, { alignment: 'center', bold: true, fillColor: '#eef2e7', ...opts });

/** Work times are stored as `HH:MM`; the paper form shows them with صباحاً/مساءً. */
function formatClockArabic(value: string): string {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return value || '—';
  const hour = Number(match[1]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return value;
  const period = hour >= 12 ? 'مساءً' : 'صباحاً';
  const hour12 = hour % 12 || 12;
  return `${String(hour12).padStart(2, '0')}:${match[2]} ${period}`;
}
const line = { hLineWidth: () => 0.7, vLineWidth: () => 0.7, hLineColor: () => '#5c6f63', vLineColor: () => '#5c6f63', paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 5, paddingBottom: () => 5 };

export function dailyReportPdf(report: DailyReport, timezone: string): Promise<Buffer> {
  const created = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: timezone }).format(report.createdAt).replace(',', '');
  const signedDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeZone: timezone }).format(report.signedAt);
  const blank = (): Content => ({ text: '' });
  // The paper form is RTL. PDFMake lays table columns out left-to-right, so the
  // column array is reversed to put "م" on the right and "نتيجة الزيارة" on the left.
  const widths = [128, 112, 64, 46, 76, 64, 48, 48, 92, 22];
  const rows: Content[][] = [
    [head('نتيجة الزيارة', widths[0], { rowSpan: 2 }), head('التوصيات', widths[1], { rowSpan: 2 }), head('المزرعة', widths[2] + widths[3], { colSpan: 2 }), blank(), head('رقم الهاتف العميل / المزرعة', widths[4], { rowSpan: 2 }), head('العنوان', widths[5] + widths[6] + widths[7], { colSpan: 3 }), blank(), blank(), head('اسم العميل / المزرعة', widths[8], { rowSpan: 2 }), head('م', widths[9], { rowSpan: 2 })],
    [blank(), blank(), head('أهم المحاصيل', widths[2]), head('المساحة بالفدان', widths[3]), blank(), head('قرية / منطقة', widths[5]), head('مركز', widths[6]), head('محافظة', widths[7]), blank(), blank()],
  ];
  for (const visit of report.visits) {
    rows.push([
      cell(visit.outcome, widths[0]), cell(visit.recommendations, widths[1]), cell(visit.crops, widths[2]), cell(visit.areaFeddan === null ? '' : visit.areaFeddan, widths[3], { alignment: 'center' }),
      cell(visit.phone, widths[4], { alignment: 'center' }), cell(visit.village, widths[5]), cell(visit.district, widths[6]), cell(visit.governorate, widths[7]), cell(visit.customerName, widths[8]), cell(visit.position, widths[9], { alignment: 'center' }),
    ]);
  }
  const doc: TDocumentDefinitions = {
    pageSize: 'A4', pageOrientation: 'landscape', pageMargins: [28, 26, 28, 34],
    defaultStyle: { font: 'Naskh', fontSize: 9, lineHeight: 1.25 },
    info: { title: `تقرير عمل يومي - ${report.reportDate}`, author: report.engineerName, subject: 'تقرير عمل يومي للمهندسين' },
    footer: (page: number, pages: number) => ({ text: wrapText(`مهندس مبيعات الهلب · صفحة ${page} من ${pages}`, 780, 8), alignment: 'center', fontSize: 8, color: '#7a897d', margin: [0, 8, 0, 0] }),
    content: [
      { text: wrapText('تقرير عمل يومي', 780, 18, true), alignment: 'center', bold: true, fontSize: 18, margin: [0, 0, 0, 10] },
      {
        table: { widths: [250, 120, 120, 250], body: [[
          cell(`اسم المهندس / ${report.engineerName}`, 250, { alignment: 'right', bold: true }),
          cell('التاريخ /', 120, { alignment: 'right' }),
          { text: report.reportDate, alignment: 'right', fontSize: 9 },
          cell(`اليوم / ${report.dayName}`, 250, { alignment: 'right' }),
        ]] }, layout: 'noBorders', margin: [0, 0, 0, 6],
      },
      {
        table: { widths: [300, 110, 220, 110], body: [[
          cell('تم الخروج إلى العمل بهذا اليوم الساعة /', 300, { alignment: 'right' }),
          { text: formatClockArabic(report.leftAt), alignment: 'right', fontSize: 9 },
          cell('الرجوع من العمل الساعة /', 220, { alignment: 'right' }),
          { text: formatClockArabic(report.returnedAt), alignment: 'right', fontSize: 9 },
        ]] }, layout: 'noBorders', margin: [0, 0, 0, 10],
      },
      { text: wrapText('وقمت بزيارة الآتي:', 780, 11, true), bold: true, fontSize: 11, margin: [0, 0, 0, 5] },
      {
        table: { headerRows: 2, dontBreakRows: true, widths, body: rows },
        layout: line,
      },
      {
        table: { widths: [380, 120, 240], body: [[
          cell(`توقيع المهندس / ${report.signedName}`, 380, { alignment: 'right', bold: true }),
          { text: signedDate, alignment: 'center', fontSize: 8, color: '#5c6f63' },
          cell('توقيع إلكتروني بتاريخ', 240, { alignment: 'left', fontSize: 8, color: '#5c6f63' }),
        ]] }, layout: 'noBorders', margin: [0, 12, 0, 0],
      },
      { text: wrapText(`أُرسل عبر مهندس مبيعات الهلب بواسطة ${report.repName}`, 780, 8), fontSize: 8, color: '#7a897d', margin: [0, 6, 0, 0] },
      { text: created, fontSize: 8, color: '#7a897d', alignment: 'left', margin: [0, 2, 0, 0] },
    ],
  };
  return new Promise((resolve, reject) => {
    const stream = printer.createPdfKitDocument(doc);
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    stream.end();
  });
}
