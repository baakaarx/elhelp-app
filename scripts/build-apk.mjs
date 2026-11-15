#!/usr/bin/env node
/**
 * Builds an installable APK for the engineer app — the same command on Windows, macOS and Linux.
 *
 *   npm run build:apk -- http://55.0.55.70:3000
 *   npm run build:apk -- https://tracking.company.com --clean
 *   npm run build:apk -- --debug            (dev build that needs Metro)
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

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const mobile = join(root, 'mobile');
const androidDir = join(mobile, 'android');
const envFile = join(mobile, '.env');
const isWindows = process.platform === 'win32';

/* ── arguments ─────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const flags = new Set(args.filter(arg => arg.startsWith('--')));
const positional = args.filter(arg => !arg.startsWith('--'));
const apiUrlFlag = args.find(arg => arg.startsWith('--api-url='));

const clean = flags.has('--clean');
const debugBuild = flags.has('--debug');

function fail(message, hint) {
  console.error(`\n\u2716 ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}
const step = message => console.log(`\n\u25b8 ${message}`);

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
function firstExisting(candidates, marker) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (marker) {
      if (existsSync(join(candidate, marker))) return candidate;
    } else if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
const javaHome = firstExisting([
  process.env.JAVA_HOME,
  'C:\\Program Files\\Android\\Android Studio\\jbr',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Android Studio', 'jbr'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'JetBrains', 'Toolbox', 'apps', 'AndroidStudio', 'ch-0', 'jbr'),
  '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  '/usr/lib/jvm/java-17-openjdk-amd64',
  '/usr/lib/jvm/default-java',
], isWindows ? 'bin\\java.exe' : 'bin/java');
if (!javaHome) {
  fail('No Java runtime found (JDK 17).',
    'Install Android Studio (it bundles the JBR) or point JAVA_HOME at a JDK 17.');
}

const androidHome = firstExisting([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  process.env.HOME && join(process.env.HOME, 'Android', 'Sdk'),
  process.env.HOME && join(process.env.HOME, 'Library', 'Android', 'sdk'),
  '/usr/lib/android-sdk',
], 'platform-tools');
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
const variant = debugBuild ? 'debug' : 'release';
const task = debugBuild ? 'assembleDebug' : 'assembleRelease';
step(`Building the ${variant} APK (first run downloads Gradle: 5-15 minutes)`);
const gradle = spawnSync(isWindows ? 'gradlew.bat' : './gradlew', [task, '--no-daemon'], {
  cwd: androidDir, stdio: 'inherit', env, shell: isWindows,
});
if (gradle.status !== 0) fail(`Gradle failed (exit ${gradle.status}).`, 'The first error above names the missing SDK or JDK piece.');

/* ── 6. result ─────────────────────────────────────────────────────────────── */
const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
if (!existsSync(apk)) fail(`The build finished but ${apk} is missing.`);

const version = (readFileSync(join(mobile, 'app.config.ts'), 'utf8').match(/version:\s*'([^']+)'/) || [])[1] || '1.0.0';
const outDir = join(mobile, 'dist-android');
mkdirSync(outDir, { recursive: true });
const target = join(outDir, `elhelp-engineer-${version}-${variant}.apk`);
copyFileSync(apk, target);
try { chmodSync(target, 0o644); } catch { /* windows */ }

const megabytes = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`\n\u2714 APK ready (${megabytes} MB)`);
console.log(`  ${target}\n`);
console.log(`  install on a USB-connected phone:  adb install -r "${target}"`);
if (/^http:\/\//i.test(apiUrl)) {
  console.log('\n  note: plain HTTP, so this build allows cleartext traffic. HTTPS is recommended.');
}
if (debugBuild) {
  console.log('  note: a debug APK only runs while Metro (npm run start) is reachable.');
}
