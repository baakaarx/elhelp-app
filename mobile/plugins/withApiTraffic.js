/**
 * Android blocks plain HTTP from release builds (API 28+), which would leave the engineer app
 * showing "لا يوجد اتصال" the moment the server is reached over http:// instead of https://.
 *
 * This plugin only relaxes that rule when the configured API really is http:, so an HTTPS
 * deployment keeps the strict default and nothing has to be remembered at build time.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const isHttp = value => typeof value === 'string' && /^http:\/\//i.test(value.trim());

module.exports = function withApiTraffic(config) {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL || config.extra?.apiUrl || '';
  if (!isHttp(apiUrl)) return config;
  console.warn(`[withApiTraffic] ${apiUrl} is plain HTTP: allowing cleartext for this build. HTTPS is recommended.`);
  return withAndroidManifest(config, cfg => {
    const application = cfg.modResults.manifest.application?.[0];
    if (application) application.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
};
