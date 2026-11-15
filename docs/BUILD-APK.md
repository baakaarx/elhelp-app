# بناء APK لتطبيق المهندس

التطبيق اللي بيتثبّت على موبايل المهندس هو **نسخة release**: الـJavaScript جوّه الملف، فبيشتغل
لوحده بعد التثبيت من غير Metro ولا كمبيوتر. **نسخة debug** لازم تكون متصلة بسيرفر التطوير
وإلا هتفتح على شاشة حمرا — فمتستخدمهاش للتوزيع.

---

## ١) قبل ما تبدأ: عنوان السيرفر

التطبيق بياخد عنوان الـAPI **وقت البناء** (مش بعد التثبيت)، فحدده الأول:

| الحالة | العنوان |
| --- | --- |
| السيرفر على VPS بدومين | `https://tracking.your-company.com` ← **الأفضل** |
| السيرفر على جهاز في نفس الشبكة | `http://192.168.1.20:3000` (IP الجهاز من `ipconfig`) |
| سيرفر بعنوان عام بدون دومين | `http://55.0.55.70:3000` |

قواعد:
- **ممنوع** `localhost` أو `127.0.0.1` — دي بتشاور على الموبايل نفسه.
- الموبايل لازم يوصل للعنوان فعلاً: جرّب تفتحه من متصفح الموبايل قبل البناء.
- لو العنوان `http://`: أندرويد بيمنع الاتصال غير المشفّر في نسخة release، ومشروعنا بيسمح به
  تلقائيًا وقت البناء طالما العنوان http (ملف `mobile/plugins/withApiTraffic.js`). مع `https://`
  الإعداد بيرجع للوضع الآمن بدون أي خطوة منك.

---

## ٢) الطريقة السريعة — أمر واحد (ويندوز وماك ولينكس)

```powershell
cd C:\Users\mo.ai\projects\elhelp-app
git pull
npm ci
npm run build:apk -- http://55.0.55.70:3000
```

السكربت (`scripts/build-apk.mjs`) بيعمل كل حاجة: يكتب `mobile\.env` → يتأكد من Java وAndroid SDK
(وبيلاقيهم تلقائيًا في مسار Android Studio) → `expo prebuild` أول مرة → `gradlew assembleRelease`
→ ينسخ الناتج ويطبع مساره:

```
mobile\dist-android\elhelp-engineer-1.0.0-release.apk
```

خيارات:

```powershell
npm run build:apk -- https://tracking.company.com --clean   # أعِد توليد مجلد أندرويد من الأول
npm run build:apk -- http://192.168.1.20:3000 --debug       # debug للتجربة مع Metro فقط
npm run build:apk                                            # يستخدم العنوان الموجود في mobile\.env
```

> على لينكس/ماك/VPS: `./scripts/build-apk.sh https://tracking.company.com` — نفس الملف ونفس الخطوات.
>
> **ليه مفيش سكربت PowerShell؟** Windows PowerShell 5.1 بيقرا أي `.ps1` بدون BOM على إنه ANSI،
> فالنص العربي جوّه السكربت بيتحوّل لرموز ويكسر الملف (`Missing closing ')'`). النسخة الحالية
> مكتوبة بـNode ورسائلها إنجليزي بسيط، فمفيش مشكلة ترميز ولا فرق بين الأنظمة.

## ٣) الطريقة اليدوية — Android Studio

1. **مرة واحدة:** ولّد مجلد أندرويد من جذر المشروع:
   ```powershell
   cd mobile
   "EXPO_PUBLIC_API_URL=http://55.0.55.70:3000" | Set-Content .env
   npx expo prebuild --platform android
   ```
2. افتح Android Studio → **Open** → اختَر `mobile\android` (المجلد ده، مش جذر المشروع).
3. استنى **Gradle Sync** يخلص (أول مرة بينزّل حاجات، ٥–١٥ دقيقة).
4. `Build ▸ Build Bundle(s) / APK(s) ▸ Build APK(s)`.
5. اضغط **locate** في الرسالة اللي تحت، أو روح للمسار:
   ```
   mobile\android\app\build\outputs\apk\debug\app-debug.apk
   ```

⚠️ الزرار ده بيطلّع **debug** (محتاج Metro). للنسخة المستقلة:

- في Android Studio: `Build ▸ Select Build Variant…` → اختار **release** → وبعدين APK(s).
- أو من الطرفية (أسرع وأنضف):
  ```powershell
  cd mobile\android
  .\gradlew assembleRelease
  # الناتج: app\build\outputs\apk\release\app-release.apk
  ```
  محتاج `JAVA_HOME` و`ANDROID_HOME`:
  ```powershell
  $env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
  $env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
  ```

> لو غيّرت `EXPO_PUBLIC_API_URL` بعد ما ولّدت `mobile\android`، لازم `prebuild --clean` أو استخدم
> السكربت — العنوان بيتحرق جوّه المشروع وقت التوليد.

---

## ٤) الطريقة السحابية — من GitHub بدون أي تثبيت

`Actions ▸ Android APK ▸ Run workflow` → اكتب عنوان الـAPI → بعد ~١٠ دقائق نزّل الـAPK من
**Artifacts** في نفس صفحة التشغيل. (الـworkflow: `.github/workflows/android-apk.yml`)

---

## ٥) التوقيع الرسمي (لـ Google Play فقط)

نسخة release الافتراضية بتتوقّع بكيستور الـdebug، وده كافي للتركيب المباشر على موبايلات الشركة.
للنشر على Play محتاج مفتاحك الخاص:

```powershell
cd mobile
keytool -genkeypair -v -keystore elhelp-release.keystore -alias elhelp `
  -keyalg RSA -keysize 2048 -validity 10000
```

بعدها في `mobile\android\app\build.gradle`:

```gradle
android {
    signingConfigs {
        release {
            storeFile file('../../elhelp-release.keystore')
            storePassword System.getenv('ELHELP_STORE_PASSWORD')
            keyAlias 'elhelp'
            keyPassword System.getenv('ELHELP_KEY_PASSWORD')
        }
    }
    buildTypes {
        release { signingConfig signingConfigs.release }
    }
}
```

- **لا تحط** كلمات السر ولا الملف نفسه في Git (`*.keystore` و`*.jks` مستثناة في `.gitignore`).
- `mobile\android` مُولَّد ومستثنى، فأي تعديل فيه بيضيع مع `prebuild --clean`. لو محتاج التوقيع
  يتكرر بشكل دائم، خزّنه في `keystore.properties` + خد نسخة من `build.gradle`، أو استخدم EAS:
  `npx eas build -p android --profile production` (بيطلّع AAB لـPlay).
- للنشر على Play لازم **AAB** مش APK:
  ```powershell
  cd mobile\android && .\gradlew bundleRelease
  # app\build\outputs\bundle\release\app-release.aab
  ```

---

## ٦) بعد التثبيت على موبايل المهندس

1. اسمح بالموقع **«السماح دائمًا»** (مش «أثناء الاستخدام فقط») — وإلا التتبع بيقف لما الشاشة تقفل.
2. إعدادات البطارية → التطبيق → **«بدون قيود»** (Battery → Unrestricted).
3. المدير يعمل حساب المهندس من «نخبة الفريق»، وبعدها المهندس يدخل ويبدأ وردية.
4. أول اختبار: افتح التطبيق، سجّل دخول، ابدأ وردية، واتأكد إن اللوحة بتظهر حركته.

---

## ٧) مشاكل شائعة

| الرسالة | السبب والحل |
| --- | --- |
| `Unable to load script` / شاشة حمرا | ثبّتّ نسخة debug بدون Metro → ابنِ `assembleRelease`. |
| `CLEARTEXT communication not permitted` | العنوان http والبناء اتعمل من غير `withApiTraffic` (مثلاً نسخة قديمة أو prebuild قبل التعديل) → أعد `prebuild` بالسكربت. |
| `لا يوجد اتصال بالإنترنت` جوّه التطبيق | العنوان غلط أو الموبايل مش واصل للسيرفر: جرّب نفس العنوان في متصفح الموبايل. |
| `SDK location not found` | أنشئ `mobile\android\local.properties` فيه `sdk.dir=C\:\\Users\\mo.ai\\AppData\\Local\\Android\\Sdk` (لاحظ الـ`\\`). |
| `'JAVA_HOME' is not set` | `$env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"`. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | نسخة قديمة بنفس الحزمة: `adb uninstall com.elhelb.mandoub` ثم ثبّت. |
| Gradle واقف عند `Downloading…` | أول بناء بينزّل Gradle + الاعتماديات؛ لو الشبكة مقفولة استخدم الطريقة السحابية (بند ٤). |
| `userInterfaceStyle: install expo-system-ui` | ملاحظة غير مؤثرة أثناء `prebuild`، متعملش حاجة. |

---

## ٨) تفاصيل تقنية

- الحزمة: `com.elhelb.mandoub` — نسخة التطبيق: `1.0.0` (`mobile/app.config.ts`).
- الصلاحيات: موقع (دقيق/تقريبي/في الخلفية)، خدمة أمامية، إشعارات، إنترنت.
- التصدير للويب (`npm run export:mobile`) يخص `/app` على السيرفر، مالوش علاقة بالـAPK.
- ملفات `mobile/android` و`mobile/ios` مستثناة من Git، وتُولَّد بـ`expo prebuild` على أي جهاز.
