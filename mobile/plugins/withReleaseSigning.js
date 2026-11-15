/**
 * Signs release builds with the operator's own upload key when `mobile/keystore.properties`
 * exists, instead of the debug keystore that Expo's template ships with.
 *
 * Without the file nothing changes (a release APK signed with the debug key is still fine for
 * sideloading). With it, `assembleRelease` / `bundleRelease` produce a build Google Play accepts.
 *
 * The keystore and its properties file live outside git, so this plugin is the only place that
 * knows how to wire them in — and it survives every `expo prebuild`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { withAppBuildGradle } = require('@expo/config-plugins');

const escape = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function readProperties(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s][^=]*)\s*=\s*(.*)$/);
    if (match) values[match[1].trim()] = match[2].trim();
  }
  return values;
}

module.exports = function withReleaseSigning(config, props = {}) {
  const projectRoot = props.projectRoot || process.cwd();
  const propertiesFile = path.join(projectRoot, 'keystore.properties');
  if (!fs.existsSync(propertiesFile)) return config;

  const values = readProperties(fs.readFileSync(propertiesFile, 'utf8'));
  if (!values.storeFile || !values.storePassword || !values.keyAlias || !values.keyPassword) {
    throw new Error('[withReleaseSigning] keystore.properties needs storeFile, storePassword, keyAlias and keyPassword.');
  }
  const storeFile = path.resolve(projectRoot, values.storeFile).replace(/\\/g, '/');

  return withAppBuildGradle(config, cfg => {
    let contents = cfg.modResults.contents;
    if (contents.includes('// @generated release signing')) return cfg;
    contents = contents.replace(/signingConfigs\s*\{/, match => `${match}
        // @generated release signing
        release {
            storeFile file("${storeFile}")
            storePassword "${escape(values.storePassword)}"
            keyAlias "${escape(values.keyAlias)}"
            keyPassword "${escape(values.keyPassword)}"
        }`);
    // Only the release build type switches key; debug keeps the template's debug keystore.
    contents = contents.replace(
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/,
      '$1signingConfig signingConfigs.release',
    );
    cfg.modResults.contents = contents;
    return cfg;
  });
};
