#!/usr/bin/env node
/**
 * Builds an installable APK for the engineer app — the same command on Windows, macOS and Linux.
 *
 *   npm run build:apk -- http://55.0.55.70:3000
 *   npm run build:apk -- https://tracking.company.com --clean
 *   npm run build:apk -- --debug            (dev build that needs Metro)
 *   npm run build:aab -- https://…          (Play Store bundle, needs `npm run keystore`)
 *
 * Why Node and not PowerShell: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so every
 * Arabic string in the script was mangled into syntax errors. Node reads UTF-8 everywhere.
 *
 * Output messages are ASCII on purpose: the Windows console codepage mangles Arabic, and a
 * build script must never be the reason someone cannot read an error.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, isWindows, resolveAndroidHome, resolveJavaHome, step } from './lib/android.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const mobile = join(root, 'mobile');
const androidDir = join(mobile, 'android');
const envFile = join(mobile, '.env');
/* ── arguments ─────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const flags = new Set(args.filter(arg => arg.startsWith('--')));
const positional = args.filter(arg => !arg.startsWith('--'));
const apiUrlFlag = args.find(arg => arg.startsWith('--api-url='));

const clean = flags.has('--clean');
const debugBuild = flags.has('--debug');
/** `--aab` produces the Play Store bundle instead of an APK; it requires a real keystore. */
const appBundle = flags.has('--aab');

/* ── 1. the API address the phone will talk to ─────────────────────────────── */
let apiUrl = (apiUrlFlag ? apiUrlFlag.slice('--api-url='.length) : positional[0]) || process.env.EXPO_PUBLIC_API_URL || '';
if (!apiUrl && existsSync(envFile)) {
  const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find(row => /^\s*EXPO_PUBLIC_API_URL\s*=/.test(row));
  if (line) apiUrl = line.split('=').slice(1).join('=').trim();
}
if (!apiUrl) {
  fail('No API address given.',
    'Run: npm run build:apk -- http://YOUR-SERVER-IP:3000   (or https://your-domain.com)');
}
apiUrl = apiUrl.trim().replace(/\/+$/, '');
if (!/^https?:\/\//i.test(apiUrl)) fail(`"${apiUrl}" must start with http:// or https://`);
if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(apiUrl)) {
  fail(`"${apiUrl}" points at the phone itself, not at the server.`,
    'Use the PC address from `ipconfig` (same Wi-Fi) or the server domain.');
}

step(`API base URL: ${apiUrl}`);
writeFileSync(envFile, `EXPO_PUBLIC_API_URL=${apiUrl}\n`, 'utf8');
console.log('  written to mobile/.env — the address is baked into the APK at build time.');

/* ── 2. dependencies ───────────────────────────────────────────────────────── */
if (!existsSync(join(root, 'node_modules'))) {
  step('Installing npm packages (first run)');
  const result = spawnSync(isWindows ? 'npm.cmd' : 'npm', ['ci'], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.status !== 0) fail('npm ci failed.');
}

/* ── 3. JDK and Android SDK ────────────────────────────────────────────────── */
const javaHome = resolveJavaHome();
if (!javaHome) {
  fail('No Java runtime found (JDK 17).',
    'Install Android Studio (it bundles the JBR) or point JAVA_HOME at a JDK 17.');
}
const androidHome = resolveAndroidHome();
if (!androidHome) {
  fail('Android SDK not found.',
    'Open Android Studio > Settings > Languages & Frameworks > Android SDK, install a platform + build-tools, or set ANDROID_HOME.');
}
console.log(`  JAVA_HOME    = ${javaHome}`);
console.log(`  ANDROID_HOME = ${androidHome}`);

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: androidHome,
  PATH: [join(javaHome, 'bin'), join(androidHome, 'platform-tools'), process.env.PATH || ''].join(delimiter),
};

/* ── 4. the native project ─────────────────────────────────────────────────── */
if (clean && existsSync(androidDir)) {
  step('Removing mobile/android');
  rmSync(androidDir, { recursive: true, force: true });
}
if (!existsSync(join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew'))) {
  step('Generating the Android project (expo prebuild)');
  const prebuild = spawnSync(isWindows ? 'npx.cmd' : 'npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], {
    cwd: mobile, stdio: 'inherit', env, shell: isWindows,
  });
  if (prebuild.status !== 0) fail('expo prebuild failed.', 'Delete mobile\\android and run the command again.');
} else {
  console.log('\n  mobile/android already exists — reusing it (pass --clean to regenerate).');
}

/* ── 5. gradle ─────────────────────────────────────────────────────────────── */
if (appBundle && !existsSync(join(mobile, 'keystore.properties'))) {
  fail('An .aab for Google Play must be signed with your own key.',
    'Run `npm run keystore` first (it creates mobile/elhelp-release.keystore and keystore.properties).');
}
const variant = debugBuild ? 'debug' : 'release';
const task = appBundle ? 'bundleRelease' : debugBuild ? 'assembleDebug' : 'assembleRelease';
step(`Building the ${appBundle ? 'AAB' : `${variant} APK`} (first run downloads Gradle: 5-15 minutes)`);
const gradle = spawnSync(isWindows ? 'gradlew.bat' : './gradlew', [task, '--no-daemon'], {
  cwd: androidDir, stdio: 'inherit', env, shell: isWindows,
});
if (gradle.status !== 0) fail(`Gradle failed (exit ${gradle.status}).`, 'The first error above names the missing SDK or JDK piece.');

/* ── 6. result ─────────────────────────────────────────────────────────────── */
const built = appBundle
  ? join(androidDir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab')
  : join(androidDir, 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
if (!existsSync(built)) fail(`The build finished but ${built} is missing.`);

const version = (readFileSync(join(mobile, 'app.config.ts'), 'utf8').match(/version:\s*'([^']+)'/) || [])[1] || '1.0.0';
const outDir = join(mobile, 'dist-android');
mkdirSync(outDir, { recursive: true });
const extension = appBundle ? 'aab' : 'apk';
const target = join(outDir, `elhelp-engineer-${version}-${variant}.${extension}`);
copyFileSync(built, target);
try { chmodSync(target, 0o644); } catch { /* windows */ }

const megabytes = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`\n\u2714 ${appBundle ? 'AAB' : 'APK'} ready (${megabytes} MB)`);
console.log(`  ${target}\n`);
if (appBundle) {
  console.log('  upload this .aab in Google Play Console > Internal testing (or `eas submit`).');
} else {
  console.log(`  install on a USB-connected phone:  adb install -r "${target}"`);
}
if (/^http:\/\//i.test(apiUrl)) {
  console.log('\n  note: plain HTTP, so this build allows cleartext traffic. HTTPS is recommended.');
}
if (debugBuild) {
  console.log('  note: a debug APK only runs while Metro (npm run start) is reachable.');
}
