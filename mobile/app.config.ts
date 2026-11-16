import type { ExpoConfig } from 'expo/config';

/**
 * The one setting a release build cannot guess: where the company server lives.
 *
 * `mobile/.env` is gitignored, so a cloud (EAS) build never sees it. Without this guard the
 * bundle silently fell back to `http://127.0.0.1:3000` and the shipped app only ever said
 * "لا يوجد اتصال" — a store build that cannot reach the server, discovered after review.
 */
const apiUrl = (process.env.EXPO_PUBLIC_API_URL || '').trim();
const easProjectId = (process.env.EAS_PROJECT_ID || process.env.EAS_BUILD_PROJECT_ID || '').trim();
const googleServicesFile = (process.env.GOOGLE_SERVICES_JSON || '').trim();
const notificationMode = process.env.EAS_BUILD_PROFILE === 'production' ? 'production' : 'development';
if (!/^https?:\/\/[^/]/i.test(apiUrl)) {
  if (process.env.EAS_BUILD === 'true') {
    throw new Error(
      'EXPO_PUBLIC_API_URL is missing for this EAS build. Set it with\n' +
      "  eas env:create --name EXPO_PUBLIC_API_URL --value https://your-domain --environment production --visibility plaintext\n" +
      'or add build.<profile>.env.EXPO_PUBLIC_API_URL to mobile/eas.json. See docs/PUBLISH.md.',
    );
  }
  console.warn('[app.config] EXPO_PUBLIC_API_URL is empty: this build will show the "not configured" screen.');
}

const config: ExpoConfig = {
  name: 'الهلب جروب · مهندس الميدان',
  slug: 'elhelb-mandoub',
  scheme: 'elhelbmandoob',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  icon: './assets/icon.png',
  assetBundlePatterns: ['**/*'],
  ios: {
    // iPhone only: an app that also runs on iPad has to ship a full set of iPad screenshots
    // for review, and this tool is used on the engineers' phones.
    supportsTablet: false,
    bundleIdentifier: 'com.elhelb.mandoub',
    // Required for the native "Sign in with Apple" sheet (Apple 4.8: an app that offers any
    // other social sign-in must offer Apple's too).
    usesAppleSignIn: true,
    // TestFlight/App Store reject a build number that was used before, and `expo prebuild`
    // always writes 1 — same trap as Android's versionCode.
    buildNumber: String(Number(process.env.IOS_BUILD_NUMBER || '1') || 1),
    infoPlist: {
      // The app only stores data on the company's own server over HTTPS: no custom or
      // non-exempt encryption. Declaring it saves the export-compliance question per build.
      ITSAppUsesNonExemptEncryption: false,
      NSLocationWhenInUseUsageDescription: 'نستخدم موقعك أثناء الوردية لتسجيل مسار الزيارات الميدانية.',
      NSLocationAlwaysAndWhenInUseUsageDescription: 'نستمر في تسجيل الموقع أثناء الوردية فقط، حتى لو كان التطبيق في الخلفية، بموافقتك.',
      UIBackgroundModes: ['location'],
    },
  },
  android: {
    package: 'com.elhelb.mandoub',
    ...(googleServicesFile ? { googleServicesFile } : {}),
    // Play rejects a bundle whose versionCode was already used; `npm run build:aab -- ...
    // --version-code=7` (or ANDROID_VERSION_CODE) raises it without hand-editing Gradle.
    versionCode: Number(process.env.ANDROID_VERSION_CODE || '1') || 1,
    // Matches the artwork's own corner colour, so the mask edge never shows a different navy.
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#020305' },
    // POST_NOTIFICATIONS is required at runtime on Android 13+ for the opt-in review alerts.
    permissions: ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'ACCESS_BACKGROUND_LOCATION', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_LOCATION', 'POST_NOTIFICATIONS'],
  },
  web: { bundler: 'metro', output: 'single', favicon: './assets/favicon.png' },
  plugins: [
    ['expo-location', {
      locationAlwaysAndWhenInUsePermission: 'نستمر في تسجيل الموقع أثناء الوردية فقط، حتى لو كان التطبيق في الخلفية، بموافقتك.',
      locationWhenInUsePermission: 'نستخدم موقعك أثناء الوردية لتسجيل مسار الزيارات الميدانية.',
      isAndroidBackgroundLocationEnabled: true,
      isAndroidForegroundServiceEnabled: true,
    }],
    './plugins/withApiTraffic',
    './plugins/withReleaseSigning',
    ['expo-notifications', { mode: notificationMode, defaultChannel: 'default', color: '#1f513f' }],
    'expo-apple-authentication',
    'expo-secure-store',
    'expo-sqlite',
    'expo-font',
    ['expo-splash-screen', { image: './assets/splash-icon.png', resizeMode: 'contain', backgroundColor: '#020305' }],
  ],
  experiments: { baseUrl: process.env.EXPO_BASE_URL || undefined },
  extra: {
    apiUrl,
    ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
  },
};

export default config;
