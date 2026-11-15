#!/usr/bin/env node
/**
 * Creates the upload key that Google Play expects, plus the `keystore.properties` the build
 * reads. Nothing secret is written into the repository: both files are gitignored.
 *
 *   KEYSTORE_PASSWORD='…' npm run keystore
 *   KEYSTORE_PASSWORD='…' npm run keystore -- --alias elhelp --cn "Elhelb Group"
 *
 * Losing this file means losing the ability to publish updates to the same Play listing, so the
 * script ends by telling you where it is and what to back up.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, isWindows, resolveJavaHome, step } from './lib/android.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const mobile = join(root, 'mobile');
const keystore = join(mobile, 'elhelp-release.keystore');
const propertiesFile = join(mobile, 'keystore.properties');

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const alias = flag('--alias') || process.env.KEY_ALIAS || 'elhelp';
const password = process.env.KEYSTORE_PASSWORD || flag('--store-password');
const keyPassword = process.env.KEY_PASSWORD || password;
const commonName = flag('--cn') || process.env.KEY_CN || 'Elhelb Group';
const force = args.includes('--force');

if (!password || password.length < 6) {
  fail('Set KEYSTORE_PASSWORD (6+ characters).',
    "Example: KEYSTORE_PASSWORD='a-long-passphrase' npm run keystore");
}
if (existsSync(keystore) && !force) {
  fail(`${keystore} already exists.`, 'Pass --force only if you really mean to replace the upload key.');
}

const javaHome = resolveJavaHome();
if (!javaHome) fail('No Java runtime found (JDK 17) — keytool ships with it.', 'Install Android Studio or set JAVA_HOME.');
const keytool = join(javaHome, 'bin', isWindows ? 'keytool.exe' : 'keytool');

step(`Creating ${keystore}`);
const created = spawnSync(keytool, [
  '-genkeypair', '-v',
  '-keystore', keystore,
  '-alias', alias,
  '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
  '-storepass', password, '-keypass', keyPassword,
  '-dname', `CN=${commonName}, O=${commonName}, C=EG`,
], { stdio: 'inherit' });
if (created.status !== 0) fail('keytool failed.', 'Check the message above; usually the password is too short.');

// The build plugin (mobile/plugins/withReleaseSigning.js) reads exactly these keys.
writeFileSync(propertiesFile, [
  '# Google Play upload key. Never commit this file.',
  `storeFile=${keystore.replace(/\\/g, '\\\\')}`,
  `storePassword=${password}`,
  `keyAlias=${alias}`,
  `keyPassword=${keyPassword}`,
  '',
].join('\n'), 'utf8');

step('Fingerprint');
spawnSync(keytool, ['-list', '-v', '-keystore', keystore, '-alias', alias, '-storepass', password], { stdio: 'inherit' });

console.log('\n\u2714 Ready');
console.log(`  keystore:   ${keystore}`);
console.log(`  properties: ${propertiesFile}`);
console.log('\n  Back both files up somewhere safe (password manager / encrypted drive).');
console.log('  Without them you cannot publish updates to the same Google Play listing.');
console.log('  Build the bundle with:  npm run build:aab -- https://your-domain.com\n');
