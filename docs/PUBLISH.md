# النشر على Google Play و App Store

الملف ده قائمة تنفيذ (checklist) — كل بند إما جاهز في الكود أو خطوة بتعملها مرة واحدة في حساب المتجر.

---

## ١) الحاجات اللي المشروع بقى موفّرها

| المتطلب من المتجرين | الحل في المشروع |
| --- | --- |
| **حذف الحساب من داخل التطبيق** | `DELETE /api/me` + شاشة «حسابي ← حذف الحساب» في الموبايل و«هويتي ← حذف الحساب نهائيًا» في اللوحة |
| **رابط سياسة خصوصية عام** | `https://<دومين-السيرفر>/privacy` — صفحة عربية مولّدة من إعداد السيرفر الفعلي |
| **موافقة صريحة على الموقع** | شاشة موافقة داخل التطبيق (إصدار 1.0) + مؤشر دائم أثناء التسجيل |
| **توقيع وتوزيع** | `npm run keystore` + `npm run build:aab` (وAPK للتوزيع الداخلي) |
| **بناء سحابي لـiOS** | `mobile/eas.json` جاهز (profile `production` = AAB / iOS release) |

---

## ٢) قبل أي رفع: HTTPS إلزامي

المتجرين بيرفضوا تطبيق بيتكلم `http://`. خَلّص `docs/DEPLOY-VPS.md` الأول ووصّل الدومين:

```bash
PRIVACY_CONTACT=privacy@your-company.com   # في server/.env
```

الصفحة هتبقى متاحة على `https://tracking.your-company.com/privacy` — ودي اللي تحطها في المتجرين.

---

## ٣) Google Play — خطوة بخطوة

1. **حساب**: [Play Console](https://play.google.com/console) — $25 مرة واحدة (فرد أو شركة).
2. **بناء AAB**: `npm run build:aab -- https://tracking.your-company.com`.
3. **أنشئ التطبيق** ثم **Testing ▸ Internal testing ▸ Create new release** وارفع الـAAB.
   - أول رفع بيسألك عن **Play App Signing** → اختَر «Use Google-managed key» (أسهل وأأمن).
4. **App content** (كل بند إجباري قبل المراجعة):
   - **Privacy policy**: `https://<دومين>/privacy`.
   - **Data deletion**: «التطبيق يوفّر حذف الحساب من داخله» → المسار: حسابي ← حذف الحساب.
   - **Data safety** (انظر الجدول تحت).
   - **Location permissions**: بما إن التطبيق بيستخدم `ACCESS_BACKGROUND_LOCATION`، جوجل بتطلب
     فيديو قصير (رابط عام) يوضح: ليه الموقع في الخلفية، وإزاي الموظف بيوقف التتبع.
   - **Content rating**: استبيان (التطبيق أداة عمل، لا محتوى حساس).
   - **Target audience**: 18+.
5. **Store listing**: اسم، وصف قصير/طويل بالعربي، أيقونة 512×512، صورة عرض 1024×500،
   2–8 لقطات شاشة للهاتف، تصنيف «Business».
6. **Countries** ثم **Review** — أول مراجعة عادة يوم إلى ثلاثة.

### إجابات Data safety الجاهزة

| السؤال | الإجابة |
| --- | --- |
| هل يجمع التطبيق بيانات؟ | نعم |
| أنواع البيانات | الموقع التقريبي والدقيق · المعلومات الشخصية (الاسم، البريد، الهاتف) · معلومات مالية (مبالغ التحصيل في التقارير) · سجل النشاط داخل التطبيق |
| الغرض | وظائف التطبيق (App functionality) · إدارة الحساب · الأمان ومنع إساءة الاستخدام · التحليلات التشغيلية |
| تُشارك مع أطراف ثالثة؟ | لا (المزوّدون يعملون بصفة «معالج بيانات» فقط) |
| مشفّرة أثناء النقل؟ | نعم (HTTPS) |
| يمكن طلب حذف البيانات؟ | نعم — من داخل التطبيق + البريد |
| الموقع يُجمع في الخلفية؟ | نعم — أثناء الوردية فقط، بموافقة صريحة |

---

## ٤) App Store — خطوة بخطوة

1. **حساب Apple Developer** — $99/سنة (الشركة تحتاج **D-U-N-S**، الحساب الفردي أسرع).
2. **بناء + رفع** (من غير ماك، عبر Expo):
   ```bash
   cd mobile
   npx eas-cli login
   eas init                         # يضيف projectId في app.config.ts
   eas build -p ios --profile production
   eas submit -p ios                # يرفع على TestFlight
   ```
3. **TestFlight** للتوزيع الداخلي على المهندسين قبل النشر العام.
4. **App Store Connect**:
   - **Privacy Policy URL**: `https://<دومين>/privacy`.
   - **App Privacy** (nutrition labels): Location → *Collected · Linked to the user · App Functionality*;
     Contact Info (الاسم/البريد) · Identifiers (معرّف الجهاز) · User Content (تقارير).
   - **Background location**: في `Notes for Review` اكتب:
     > التطبيق أداة عمل داخلية لمهندسي الشركة. تسجيل الموقع يبدأ بضغط المهندس على «بدء الوردية»
     > بعد موافقة صريحة، ويتوقف بإيقاف الوردية أو بإغلاق التطبيق من الإعدادات. يُستخدم لمتابعة خط
     > السير وإثبات الزيارة فقط، ويظهر المؤشر الأزرق أثناء التسجيل. بيانات الدخول تُنشأ بواسطة
     > مدير الشركة، والتطبيق لا يعمل بدون حساب.
   - **Account deletion**: متاح من داخل التطبيق (Apple 5.1.1(v)).

---

## ٥) EAS (اختياري لكن أسرع للتحديثات)

```bash
cd mobile
npx eas-cli login
eas init
eas build -p android --profile production     # AAB
eas submit -p android --profile production    # يرفع على Internal testing
eas build -p ios --profile production         # يحتاج Apple Developer
```

- `production` في `mobile/eas.json` بيولّد **AAB** لأندرويد و**release** لـiOS مع رفع رقم الإصدار تلقائيًا.
- Tracks: `submit.production.android.track = internal` (غيّرها لـ`beta` أو `production` لما تكون جاهز).

---

## ٦) التكاليف والزمن

| البند | التكلفة | ملاحظات |
| --- | --- | --- |
| Google Play | $25 مرة واحدة | + مراجعة 1–3 أيام أول مرة |
| Apple Developer | $99/سنة | TestFlight مجاني مع الحساب |
| EAS Build | مجاني بطابور أبطأ / مدفوع للسرعة | بديل ماك للبناء |
| دومين + VPS | ~$12/سنة + سيرفر | إجباري لـHTTPS |

---

## ٧) قبل الرفع — تحقق أخير

- [ ] السيرفر شغال على `https://` ودومين ثابت.
- [ ] `/privacy` بتفتح من غير تسجيل دخول وفيها بريد تواصل صحيح.
- [ ] حذف الحساب مُختبَر فعليًا على حساب تجريبي (والمدير الأخير مرفوض بحكمة).
- [ ] الـAPK/الـAAB مبني على العنوان النهائي (مش IP مؤقت).
- [ ] أيقونة 512 + صورة عرض + لقطات شاشة بالعربي.
- [ ] نسخة احتياطية من `elhelp-release.keystore` + كلمات سرّه.
