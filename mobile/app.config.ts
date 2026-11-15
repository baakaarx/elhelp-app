import type { ExpoConfig } from 'expo/config';

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
    supportsTablet: true,
    bundleIdentifier: 'com.elhelb.mandoub',
    infoPlist: {
      NSLocationWhenInUseUsageDescription: 'نستخدم موقعك أثناء الوردية لتسجيل مسار الزيارات الميدانية.',
      NSLocationAlwaysAndWhenInUseUsageDescription: 'نستمر في تسجيل الموقع أثناء الوردية فقط، حتى لو كان التطبيق في الخلفية، بموافقتك.',
      UIBackgroundModes: ['location'],
    },
  },
  android: {
    package: 'com.elhelb.mandoub',
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#0a1f33' },
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
    'expo-secure-store',
    'expo-sqlite',
    'expo-font',
    ['expo-splash-screen', { image: './assets/splash-icon.png', resizeMode: 'contain', backgroundColor: '#0a1f33' }],
  ],
  experiments: { baseUrl: process.env.EXPO_BASE_URL || undefined },
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL || '',
  },
};

export default config;
