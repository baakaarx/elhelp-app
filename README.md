# مهندس مبيعات الهلب · Elhelb Sales Engineer Tracking

تطبيق متابعة ميدانية لمهندسي مبيعات الهلب: لوحة تحكم عربية (RTL) تعرض مواقع الفريق ومسارات اليوم،
وتطبيق موبايل يسجّل الموقع أثناء الوردية فقط بموافقة صريحة، ويرسل تقارير الزيارات والتقرير اليومي
الموقّع إلكترونيًا (نفس نموذج الورق المستخدم في الشركة) مع تصدير PDF.

> هذا المستودع يحتوي على الكود الكامل القابل للتشغيل: API + لوحة التحكم + تطبيق Expo، مع ٣٩ اختبار API.

---

## المكوّنات

| المجلد | التقنية | الوظيفة |
| --- | --- | --- |
| `server/` | Node ≥ 22.13 · Express 5 · Socket.IO 4 · `node:sqlite` | REST API + بث حي + مولّد PDF عربي + سجل تدقيق |
| `dashboard/` | React 19 · Vite 8 · Leaflet | خريطة حية، بطاقات الفريق، التقارير اليومية، إدارة الحسابات |
| `mobile/` | Expo 58 · React Native 0.88 | شاشة رئيسية بملخص اليوم، تسجيل زيارات (check-in/out)، تتبع أمامي وخلفي، تقرير سريع ويومي، صندوق صادر offline |
| `e2e/` | Playwright | اختبارات المتصفح للدخول والخريطة والتقارير |

npm workspaces من الجذر، بدون monorepo tooling إضافي.

## أهم ما يفعله التطبيق

**للمهندس (الموبايل)**
- **الرئيسية:** ملخص اليوم (مسافة/زيارات/تحصيل)، عدّاد الوردية، زر بدء/إيقاف التتبع، الزيارة المفتوحة بعدّاد حيّ، مصغّر لخط سير اليوم، وآخر الزيارات.
- **الزيارات:** تسجيل حضور (check-in) لعميل/مزرعة مع GPS ونوع الزيارة، ثم إنهاء (check-out) بالنتيجة والمبلغ — والزيارة المفتوحة واحدة فقط لحماية دقة السجل.
- **التقارير:** تقرير سريع يوصل للمدير فورًا، ويعمل أوفلاين ويُرسل تلقائيًا.
- **اليومي:** نفس ورقة الشركة (وقت الخروج/العودة، ظروف، جدول زيارات، توقيع إلكتروني) ويُصدَّر PDF من اللوحة.
- **حسابي:** حالة المزامنة، الأذونات، الخصوصية، وخروج يوقف التتبع.

**للمدير (الويب)**
- **المتابعة الحية:** لوحة تنبيهات (انقطاع GPS، وردية بلا إشارة، لا زيارات، تقرير يومي ناقص)، خريطة الفريق، **إعادة تشغيل خط السير** بشريط تقدّم وسرعات، وبطاقة المهندس مع زياراته اليوم.
- **الأداء والمؤشرات:** مقارنة الفريق (زيارات، متوسط الزيارة، مسافة، تقارير، تحصيل، تقارير يومية) مع تصدير **CSV** يفتح في Excel.
- **التقارير:** مراجعة التقارير اليومية والميدانية وتنزيل PDF.
- **الفريق:** إضافة الحسابات وإيقافها فورًا (يقطع الجلسات والتتبع).

## تشغيل سريع (وضع العرض التجريبي)

```bash
npm ci
cp .env.example server/.env      # اختياري في وضع العرض
npm run dev                      # API على :3000 ولوحة التحكم على :5173
```

ثم افتح <http://localhost:5173>.

| الحساب | البريد | كلمة المرور | الاستخدام |
| --- | --- | --- | --- |
| مدير المتابعة | `admin@mandoub.test` | `Demo1234!` | لوحة التحكم |
| مهندس GPS حقيقي | `rep@mandoub.test` | `Demo1234!` | تجربة تتبع من الموبايل |
| ٥ مهندسين محاكاة | `ahmed@…` / `mohamed@…` / `sara@…` / `khaled@…` / `mostafa@mandoub.test` | `Demo1234!` | بيانات خريطة وتقارير تجريبية (لا تقبل مواقع حقيقية) |

`DEMO_MODE=true` يُنشئ بيانات العرض ومحاكي مسارات كل ثانيتين. **يمنع تشغيله في الإنتاج**
(`NODE_ENV=production` + `DEMO_MODE=true` = توقف متعمد عند بدء التشغيل).

## أوامر الجذر

```bash
npm run dev         # API + لوحة التحكم مع إعادة التحميل
npm run dev:mobile  # Expo dev server
npm run build       # بناء server ثم dashboard
npm start           # تشغيل الـ API (يقدّم dashboard/dist تلقائيًا)
npm test            # ٤٨ اختبار API (node:test + supertest + socket.io-client)
npm run typecheck   # tsc لكل الوركسبيسز
npm run test:e2e    # Playwright (يبدأ خادمًا معزولًا على 3100/5174)
npm run export:mobile  # تصدير نسخة الويب من التطبيق
npm run preview     # بناء + تصدير الموبايل + تقديم كل شيء على :5173
```

## متغيرات البيئة

انسخ `.env.example` إلى `server/.env`:

| المتغير | الافتراضي | ملاحظات |
| --- | --- | --- |
| `PORT` | `3000` | منفذ الـ API |
| `NODE_ENV` | `development` | `production` يفعّل CSP وقيود الكوكيز |
| `DEMO_MODE` | `false` | بيانات عرض + محاكي؛ ممنوع في الإنتاج |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | مطلوبان للإنتاج، كلمة المرور ١٢ حرفًا على الأقل |
| `DB_PATH` | `server/data/mandoub.db` | استخدم قرصًا دائمًا في الإنتاج |
| `RETENTION_DAYS` | `30` | ١–٣٦٥، حذف تلقائي كل ساعة |
| `TIMEZONE` | `Africa/Cairo` | حدود اليوم والمسارات والتقارير |
| `ALLOWED_ORIGINS` | — | أصول HTTPS مفصولة بفواصل (لا `*`) |

واجهة لوحة التحكم تقرأ أيضًا `MANDOOB_API_TARGET` و`MANDOOB_WEB_PORT` أثناء التطوير،
وتطبيق الموبايل يقرأ `EXPO_PUBLIC_API_URL`.

## واجهة الـ API

```
GET    /api/health
POST   /api/auth/login          { email, password } → { token, expiresAt, user }
GET    /api/auth/me             ← X-Mandoub-Token أو Authorization أو كوكي HttpOnly
POST   /api/auth/logout
GET    /api/overview            (admin) لقطات الفريق + العدادات
GET    /api/reps                (admin) · POST /api/reps · PATCH /api/reps/:id { active }
GET    /api/reps/:id/route?date=YYYY-MM-DD   (admin أو صاحب المسار)
GET    /api/me/shift            (rep) · POST /api/shifts/start { consentVersion } · POST /api/shifts/stop
GET    /api/me/summary          (rep) ملخص اليوم: مسافة، زيارات، مفتوحة، تحصيل، تقرير يومي
POST   /api/locations           (rep) دفعة حتى ١٠٠ نقطة، منع تكرار بـ point_id
POST   /api/presence
POST   /api/visits/check-in     (rep) زيارة جديدة بموقع ودقة (زيارة مفتوحة واحدة)
POST   /api/visits/:id/check-out (rep) نتيجة الزيارة + المبلغ، والتحصيل يُنسخ لتقرير مالي
GET    /api/visits?date=&status=&repId=
GET    /api/alerts              (admin) تنبيهات الميدان المشفّرة (stale_gps/no_signal/no_visits/missing_daily_report/stale_reviews)
GET    /api/kpis?from=&to=      (admin) مؤشرات لكل مهندس · GET /api/kpis.csv تصدير Excel
POST   /api/reports             (rep) · GET /api/reports · PATCH /api/reports/:id { status }
POST   /api/daily-reports       (rep) · GET /api/daily-reports · GET /api/daily-reports/:id
PATCH  /api/daily-reports/:id   (admin) { status: 'reviewed' }
GET    /api/daily-reports/:id/pdf
```

قواعد أساسية:

- **الوردية شرط للتتبع**: لا تُقبل أي نقطة خارج نطاق وردية مفتوحة للمهندس نفسه، ولا أقدم من مدة الاحتفاظ.
- **الخصوصية أولًا**: التتبع يبدأ بموافقة صريحة (`consentVersion`)، ولا يبدأ أبدًا من الخادم، ويتوقف بإنهاء الوردية أو إيقاف الحساب.
- **الصلاحيات مفصولة**: كوكي المدير لا يعمل على مسارات المهندس والعكس، والطلبات الحساسة ترفض المصادر الخارجية.
- **البيانات لا تتكرر**: كل نقطة موقع وكل تقرير له `id` من العميل، فإعادة الإرسال بعد انقطاع الشبكة آمنة.
- **المسافة تقديرية**: تُستبعد النقاط بدقة أسوأ من ١٠٠ م والقفزات غير المنطقية؛ ليست أساسًا وحيدًا للرواتب.
- **التقارير اليومية**: تقرير واحد برقم فريد لكل إرسال، عدة زيارات، توقيع إلكتروني واسم، وملف PDF عربي RTL.
- **الزيارات**: تفتح مرة واحدة لكل مهندس، ولا تُقبل إلا داخل وردية مفتوحة، وتُغلق بمدة محسوبة — وهي أساس مؤشرات الأداء وخط السير.
- **التنبيهات** تُحسب عند الطلب من البيانات نفسها (لا مهام خلفية)، فتبقى صحيحة بعد أي إعادة تشغيل.

## التقرير اليومي و PDF

النموذج مطابق لورقة «تقرير عمل يومي»: اسم المهندس، التاريخ واليوم، وقت الخروج والعودة، الظروف الطارئة،
وجدول الزيارات (اسم العميل/المزرعة، المحافظة، المركز، القرية، الهاتف، المساحة بالفدان، المحاصيل،
التوصيات، نتيجة الزيارة) ثم التوقيع الإلكتروني.

ملف PDF يُبنى على السيرفر بخط Noto Naskh Arabic، ويُعالج فصل الكلمات العربية بتقسيم الأسطر يدويًا
ثم وصلها بمسافات غير قابلة للكسر، مع الحفاظ على النص المنطقي دون عكسه.

## النشر

```bash
docker build -t elhelb-mandoub .
docker run -p 3000:3000 -v mandoub-data:/data \
  -e NODE_ENV=production -e ADMIN_EMAIL=admin@company.com -e ADMIN_PASSWORD='…' \
  -e ALLOWED_ORIGINS=https://tracking.company.com -e DB_PATH=/data/mandoub.db elhelb-mandoub
```

- التطبيق يقدّم `dashboard/dist` من نفس السيرفر (مسار واحد، بلا CORS).
- استخدم HTTPS ونطاق ثابت؛ الكوكيز تصبح `Secure; SameSite=None` تلقائيًا خلف TLS.
- `ALLOWED_ORIGINS` قائمة صريحة — لا تستخدم `*`.
- انسخ نسخة احتياطية من ملف SQLite (أو استخدم قرصًا دائمًا) — البيانات كلها هناك.
- تطبيق الموبايل: `eas build --profile production` بعد ضبط `EXPO_PUBLIC_API_URL`.

## الاختبارات و CI

```bash
npm test          # # tests 48 · # pass 48 · # fail 0
npm run typecheck # لا أخطاء
npm run build     # server/dist + dashboard/dist
```

`.github/workflows/ci.yml` يشغّل على Node 24: `npm ci` → `typecheck` → `npm test` → `build`،
ثم مهمة ثانية تشغّل Playwright بعد `npx playwright install --with-deps chromium`
(١٨ اختبار متصفح: دخول/جلسة/خريطة/تنبيهات/إعادة تشغيل المسار/مؤشرات/تقارير/تنزيل PDF وCSV).

> `node:sqlite` يحتاج Node ≥ 22.13 بدون flag. على Node 22.12 يفشل التشغيل بـ
> `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`.

## بنية البيانات (SQLite)

`users` · `sessions` · `shifts` · `locations` (مفتاح مركّب `user_id + point_id`) · `visits` · `reports` ·
`daily_reports` · `daily_report_visits` · `audit_log`.

كل ما هو أقدم من `RETENTION_DAYS` يُحذف تلقائيًا: النقاط، الجلسات المنتهية، سجل التدقيق،
والتقارير، والزيارات. الورديات المنتهية بلا نقاط تُحذف أيضًا.

## ملاحظات

- أصول الشعار (`dashboard/public/*.png`, `mobile/assets/*.png`) منقولة من مشروع الهلب لتُستخدم كعناصر نائبة؛ استبدلها بالشعار الرسمي عند النشر.
- بيانات العرض أسماء تجريبية فقط ولا تحتوي بيانات عملاء حقيقيين.
- نسخة الموافقة الحالية: `1.0`.
