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
      <li><b>بيانات العمل الميداني:</b> الزيارات (اسم العميل/المزرعة، المحافظة، المركز، القرية، الهاتف، المساحة، المحاصيل، التوصيات، النتيجة)، والطلبيات وكمياتها وحالة تسعيرها، والتقارير اليومية والميدانية القديمة، وطلبات التحصيل.</li>
      <li><b>بيانات تشغيلية:</b> معرّف الجهاز المرتبط بالدخول والجلسات، ورمز إشعارات الدفع (Expo push token) إذا فعّلت الإشعارات، وسجل الإجراءات الحساسة. إذا أبلغ نظام الهاتف أن الموقع محاكى، يُحفظ وقت البلاغ والوردية والجهاز للمراجعة — لا تُحفظ إحداثيات البلاغ.</li>
    </ul>
    <p class="muted">لا نجمع جهات الاتصال، ولا الصور، ولا الرسائل، ولا أي بيانات من تطبيقات أخرى على جهازك.</p>
  </section>

  <section>
    <h2>٣) لماذا نجمعها</h2>
    <ul>
      <li>متابعة خط السير والتأكد من وصول المهندس للزيارات في مواعيدها.</li>
      <li>إعداد التقارير اليومية واحتساب المسافات والإنجازات.</li>
      <li>حماية الحساب ومنع الاستخدام من أجهزة غير مصرّح بها، ومراجعة بلاغ الموقع المحاكى الذي يعلّمه نظام التشغيل.</li>
      <li>إرسال تنبيه عام عند مراجعة التقرير أو تغيير حالة الحساب، إذا فعّلت إشعارات الدفع من «حسابي».</li>
    </ul>
    <p>الموقع لا يُستخدم لأي غرض إعلاني أو تجاري، ولا يُباع أو يُشارك مع أي طرف ثالث لأغراض تسويقية.</p>
  </section>

  <section>
    <h2>٤) الموافقة والتحكم</h2>
    <ul>
      <li>لا يبدأ تسجيل الموقع إلا بعد موافقتك الصريحة داخل التطبيق، ويظهر مؤشر دائم أثناء التسجيل.</li>
      <li>يمكنك إيقاف التتبع في أي وقت من التطبيق (إيقاف الوردية) أو من إعدادات أندرويد/آيفون.</li>
      <li>إشعارات الدفع اختيارية: فعّلها أو أوقف إرسالها لهذا الجهاز من «حسابي»، ويمكنك كذلك منع ظهورها من إعدادات نظام الهاتف.</li>
      <li>إصدار الموافقة الحالي: <span class="pill">1.0</span></li>
    </ul>
  </section>

  <section>
    <h2>٥) من يطّلع على البيانات</h2>
    <ul>
      <li><b>مديرو المتابعة</b> داخل شركتك، بحسب صلاحياتهم الوظيفية.</li>
      <li><b>مزوّدو الخدمات التقنية:</b> الاستضافة، ومزوّد الخرائط (إحداثيات تقريبية لعرض المكان)، وخدمة Expo Push عند تفعيل التنبيهات (رمز الجهاز ونص عام مثل «تمت مراجعة تقريرك» فقط؛ لا تُرسل إحداثيات أو تفاصيل التقرير للإشعار).</li>
      <li>لا يوجد أي بيع أو تأجير للبيانات، ولا مشاركة مع شبكات إعلانات؛ يستخدم المزوّدون المذكورون البيانات لتقديم الخدمة فقط.</li>
    </ul>
  </section>

  <section>
    <h2>٦) مدة الاحتفاظ والحذف</h2>
    <p>تُحذف نقاط الموقع والتقارير والزيارات وبلاغات الموقع المحاكى تلقائيًا بعد <b>${retention}</b> يومًا من تسجيلها.
    الطلبيات لا تُحذف مع سجل الزيارات تلقائيًا؛ تظل محفوظة حتى حذف الحساب المرتبط بها. الجلسات المنتهية وسجل التدقيق يخضعان لنفس المدة. رمز Push يُحذف عند إيقاف الإشعارات أو تسجيل الخروج أو حذف الحساب، أو عندما يعلن المزوّد أن الجهاز لم يعد مسجّلًا.</p>
    <p><b>حذف الحساب:</b> من داخل تطبيق المهندس افتح <code>حسابي ← حذف الحساب</code> واكتب بريدك
    للتأكيد. يُحذف الحساب وكل بياناته (الموقع، الورديات، الزيارات، الطلبيات، التقارير القديمة) نهائيًا وفورًا،
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
<footer>الهلب جروب · هذه الصفحة هي المرجع الرسمي لسياسة الخصوصية المنشورة مع التطبيق · <a href="/delete-account">حذف الحساب والبيانات</a></footer>
</body>
</html>`;
}

/**
 * The web half of the store deletion rule.
 *
 * Google Play requires two paths for an app that creates accounts: one inside the app and one
 * on the web for people who already uninstalled it. The in-app path exists (`DELETE /api/me`);
 * this page is the link that goes into the Play Console "Account deletion" field. It states
 * what is erased, what is kept and why, and starts the request with one tap (a prefilled mail
 * to the operator), so it works without the app and without a login.
 */
export function deleteAccountPage(config: Config): string {
  const contact = escapeHtml(config.privacyContact);
  const days = config.retentionDays;
  const subject = encodeURIComponent('طلب حذف حساب — مهندس الميدان');
  const body = encodeURIComponent(
    'الاسم:\nالبريد الإلكتروني المسجّل في التطبيق:\nرقم الهاتف (اختياري):\n\nأطلب حذف حسابي وكل البيانات المرتبطة به.\n',
  );
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>حذف الحساب · الهلب جروب</title>
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
  ul, ol { margin: 6px 0; padding-inline-start: 22px; }
  li { margin: 4px 0; }
  p { margin: 6px 0; }
  a.cta { display: inline-block; margin-top: 10px; background: #1f513f; color: #fffdf8; text-decoration: none; border-radius: 12px; padding: 12px 22px; font-weight: 700; }
  .muted { color: #5d6b62; font-size: 13px; }
  .pill { display: inline-block; background: #e8f1ea; color: #1f513f; border-radius: 999px; padding: 2px 12px; font-size: 13px; }
  a { color: #1f513f; }
  footer { text-align: center; color: #6b7a71; font-size: 12px; padding-bottom: 30px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>حذف حسابك وبياناتك</h1>
    <p>الهلب جروب · تطبيق مهندس الميدان (com.elhelb.mandoub)</p>
  </div>
</header>
<main>
  <section>
    <h2>١) من يقدر يطلب الحذف</h2>
    <p>أي مهندس عنده حساب في التطبيق، سواء التطبيق لسه مثبَّت على موبايله أو شاله. الحذف بيشمل
    الحساب نفسه وكل البيانات المرتبطة بيه، ومش بيحتاج تفتح التطبيق.</p>
  </section>

  <section>
    <h2>٢) إزاي تطلب الحذف — طريقتين</h2>
    <ol>
      <li><b>فورًا من داخل التطبيق:</b> تبويب «حسابي» ← «حذف الحساب نهائيًا» ← اكتب بريدك للتأكيد.
      الحساب بيتمسح في نفس اللحظة.</li>
      <li><b>من غير التطبيق:</b> ابعت طلب من بريدك المسجّل على الرابط ده، وهننفّذه في مدة أقصاها
      <b>٧ أيام عمل</b>، وهنبلّغك على نفس البريد لما يخلص.</li>
    </ol>
    <a class="cta" href="mailto:${contact}?subject=${subject}&body=${body}">إرسال طلب حذف بالبريد</a>
    <p class="muted">أو راسلنا مباشرة على <a href="mailto:${contact}">${contact}</a> بعنوان «طلب حذف حساب».</p>
  </section>

  <section>
    <h2>٣) إيه اللي بيتمسح</h2>
    <ul>
      <li>الحساب: الاسم، البريد الإلكتروني، رقم الهاتف، المنطقة، كلمة المرور المشفّرة، ومعرّف الجهاز المرتبط.</li>
      <li>سجل الموقع بالكامل: كل نقاط GPS والمسارات والورديات المرتبطة بالحساب.</li>
      <li>الزيارات والطلبيات والتقارير اليومية والميدانية القديمة وطلبات التحصيل اللي كتبها المهندس.</li>
      <li>جلسات الدخول وأي بيانات مؤقتة على السيرفر.</li>
    </ul>
  </section>

  <section>
    <h2>٤) إيه اللي بيفضل — وليه</h2>
    <ul>
      <li><b>سجل التدقيق:</b> بيتحفظ بمعرّف الحساب بدون الاسم أو البريد، للحماية من إساءة الاستخدام
      وإثبات الإجراءات الحساسة (بدء/إيقاف وردية، حذف حساب).</li>
      <li><b>البيانات المحاسبية:</b> لو فيه تحصيل نقدي معتمد، ممكن يتحفظ الحد الأدنى اللي بيطلبه
      القانون التجاري، من غير بيانات الموقع.</li>
      <li><b>النسخ الاحتياطية:</b> بتتمسح هي كمان مع أول دورة احتفاظ، وأقصى مدة ${days} يومًا.</li>
    </ul>
    <p class="muted">مدة الاحتفاظ الحالية بالبيانات العاملة: <span class="pill">${days} يومًا</span></p>
  </section>

  <section>
    <h2>٥) قبل ما تحذف</h2>
    <p>الحذف نهائي ومش ممكن التراجع عنه. لو المدير محتاج سجل زياراتك، نزّل التقرير الشهري (Excel)
    من لوحة المتابعة قبل تنفيذ الطلب.</p>
  </section>
</main>
<footer>الهلب جروب · <a href="/privacy">سياسة الخصوصية</a> · آخر تحديث: ${escapeHtml(new Intl.DateTimeFormat('ar-EG', { dateStyle: 'long', timeZone: config.timezone }).format(new Date()))}</footer>
</body>
</html>`;
}
