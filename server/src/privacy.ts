import type { Config } from './config.js';

/**
 * The public privacy policy both app stores require a URL for.
 *
 * It is served by the API itself (`/privacy`), so every installation automatically has a
 * matching, always-current policy at https://<its-domain>/privacy — no external site to keep
 * in sync, and no risk of describing behaviour the deployed server does not have.
 */
/** Config values land in HTML, so they are escaped even though an operator writes them. */
function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));
}

export function privacyPage(config: Config): string {
  const retention = config.retentionDays;
  const updated = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'long', timeZone: config.timezone }).format(new Date());
  const contact = escapeHtml(config.privacyContact);
  const timezone = escapeHtml(config.timezone);
  const contactHref = `mailto:${contact}`;
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>سياسة الخصوصية · الهلب جروب</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f4ee; color: #16241d; font: 16px/1.95 "Noto Naskh Arabic", "Segoe UI", Tahoma, sans-serif; }
  header { background: #0a1f33; color: #f6f0dd; padding: 26px 20px; }
  header div, main { max-width: 780px; margin: 0 auto; }
  header h1 { margin: 0 0 4px; font-size: 24px; }
  header p { margin: 0; color: #c9b98a; font-size: 13px; }
  main { padding: 22px 20px 60px; }
  section { background: #fffdf8; border: 1px solid #e4e0d4; border-radius: 16px; padding: 18px 20px; margin: 0 0 14px; }
  h2 { font-size: 18px; margin: 0 0 8px; color: #12352a; }
  ul { margin: 6px 0; padding-inline-start: 20px; }
  li { margin: 4px 0; }
  p { margin: 6px 0; }
  code { background: #eef3ec; border-radius: 6px; padding: 1px 6px; direction: ltr; display: inline-block; }
  .muted { color: #5d6b62; font-size: 13px; }
  .pill { display: inline-block; background: #e8f1ea; color: #1f513f; border-radius: 999px; padding: 2px 12px; font-size: 13px; }
  a { color: #1f513f; }
  footer { text-align: center; color: #6b7a71; font-size: 12px; padding-bottom: 30px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>سياسة الخصوصية</h1>
    <p>الهلب جروب · تطبيق مهندس الميدان (com.elhelb.mandoub)</p>
  </div>
</header>
<main>
  <section>
    <h2>١) من نحن</h2>
    <p>هذه السياسة تشرح كيف تتعامل خدمة «الهلب جروب · مهندس الميدان» مع بيانات الحساب والموقع
    الجغرافي للمهندسين الميدانيين. الخدمة أداة عمل داخلية لمتابعة الزيارات الميدانية وإعداد
    التقارير، وليست خدمة موجّهة للجمهور العام.</p>
    <p class="muted">المنطقة الزمنية المستخدمة في التقارير: <span class="pill">${timezone}</span></p>
  </section>

  <section>
    <h2>٢) البيانات التي نجمعها</h2>
    <ul>
      <li><b>بيانات الحساب:</b> الاسم، البريد الإلكتروني، رقم الهاتف (اختياري)، المنطقة، والدور (مدير متابعة أو مهندس).</li>
      <li><b>الموقع الجغرافي:</b> إحداثيات ودقة وسرعة واتجاه نقطة GPS، ونسبة البطارية، ووقت التسجيل — <b>أثناء الوردية فقط</b> وبعد تشغيلك للتتبع بموافقة صريحة.</li>
      <li><b>بيانات العمل الميداني:</b> الزيارات (اسم العميل/المزرعة، المحافظة، المركز، القرية، الهاتف، المساحة، المحاصيل، التوصيات، النتيجة)، والتقارير اليومية الموقّعة إلكترونيًا، والتقارير الميدانية، وطلبات التحصيل.</li>
      <li><b>بيانات تشغيلية:</b> معرّف الجهاز المرتبط بالدخول، الجلسات، وسجل تدقيق الإجراءات الحساسة (بدء/إيقاف وردية، اعتماد حساب، تنزيل تقرير، حذف حساب).</li>
    </ul>
    <p class="muted">لا نجمع جهات الاتصال، ولا الصور، ولا الرسائل، ولا أي بيانات من تطبيقات أخرى على جهازك.</p>
  </section>

  <section>
    <h2>٣) لماذا نجمعها</h2>
    <ul>
      <li>متابعة خط السير والتأكد من وصول المهندس للزيارات في مواعيدها.</li>
      <li>إعداد التقارير اليومية واحتساب المسافات والإنجازات.</li>
      <li>حماية الحساب ومنع الاستخدام من أجهزة غير مصرّح بها.</li>
    </ul>
    <p>الموقع لا يُستخدم لأي غرض إعلاني أو تجاري، ولا يُباع أو يُشارك مع أي طرف ثالث لأغراض تسويقية.</p>
  </section>

  <section>
    <h2>٤) الموافضة والتحكم</h2>
    <ul>
      <li>لا يبدأ تسجيل الموقع إلا بعد موافقتك الصريحة داخل التطبيق، ويظهر مؤشر دائم أثناء التسجيل.</li>
      <li>يمكنك إيقاف التتبع في أي وقت من التطبيق (إيقاف الوردية) أو من إعدادات أندرويد/آيفون.</li>
      <li>إصدار الموافقة الحالي: <span class="pill">1.0</span></li>
    </ul>
  </section>

  <section>
    <h2>٥) من يطّلع على البيانات</h2>
    <ul>
      <li><b>مديرو المتابعة</b> داخل شركتك، بحسب صلاحياتهم الوظيفية.</li>
      <li><b>مزوّدو الخدمات التقنية:</b> الاستضافة التي تعمل عليها الخدمة، ومزوّد خرائط لعرض الخريطة وأسماء الشوارع (تُرسل إحداثيات تقريبية لعرض المكان فقط).</li>
      <li>لا يوجد أي بيع أو تأجير للبيانات، ولا مشاركة مع شبكات إعلانات.</li>
    </ul>
  </section>

  <section>
    <h2>٦) مدة الاحتفاظ والحذف</h2>
    <p>تُحذف نقاط الموقع والتقارير والزيارات تلقائيًا بعد <b>${retention}</b> يومًا من تسجيلها.
    الجلسات المنتهية وسجل التدقيق يخضعان لنفس المدة.</p>
    <p><b>حذف الحساب:</b> من داخل تطبيق المهندس افتح <code>حسابي ← حذف الحساب</code> واكتب بريدك
    للتأكيد. يُحذف الحساب وكل بياناته (الموقع، الورديات، الزيارات، التقارير) نهائيًا وفورًا،
    وتُلغى كل جلساته. يمكنك كذلك مراسلتنا على البريد أدناه للحذف.</p>
    <p class="muted">قد تبقى نسخ احتياطية مشفّرة على السيرفر لمدة أقصاها ${retention} يومًا قبل أن تُستبدل تلقائيًا.</p>
  </section>

  <section>
    <h2>٧) حقوقك</h2>
    <ul>
      <li>الاطلاع على بياناتك وطلب نسخة منها.</li>
      <li>تصحيح أي بيانات غير دقيقة (أو عبر مدير المتابعة).</li>
      <li>حذف الحساب والبيانات نهائيًا.</li>
      <li>سحب الموافقة وإيقاف التتبع — مع العلم أن ذلك يمنع تسجيل الزيارات.</li>
    </ul>
  </section>

  <section>
    <h2>٨) الأمان</h2>
    <ul>
      <li>كلمات المرور محفوظة بتشفير أحادي الاتجاه (scrypt) ولا يمكن استخراجها.</li>
      <li>الاتصال بين التطبيق والسيرفر مشفّر عبر HTTPS في النسخة المنشورة.</li>
      <li>الجلسات محدودة المدة، ويمكن للمدير إيقاف أي حساب فورًا فتقطع جلساته وتتبعه.</li>
    </ul>
  </section>

  <section>
    <h2>٩) الأطفال</h2>
    <p>الخدمة مخصّصة للموظفين والمهندسين الميدانيين بعمر ١٨ عامًا أو أكثر، ولا نجمع بيانات أطفال عن قصد.</p>
  </section>

  <section>
    <h2>١٠) التواصل</h2>
    <p>لأي استفسار أو طلب متعلق بالخصوصية أو حذف البيانات:
    <a href="${contactHref}">${contact}</a></p>
  </section>

  <p class="muted">آخر تحديث: ${updated}</p>
</main>
<footer>الهلب جروب · هذه الصفحة هي المرجع الرسمي لسياسة الخصوصية المنشورة مع التطبيق.</footer>
</body>
</html>`;
}
