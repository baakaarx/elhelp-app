/**
 * Small helpers shared by the Android build scripts: locating the JDK and the Android SDK the
 * way Android Studio installs them, plus consistent console output.
 *
 * Everything here is ASCII on purpose — a Windows console codepage can mangle Arabic and hide
 * the one line that explains a failed build.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const isWindows = process.platform === 'win32';

export function fail(message, hint) {
  console.error(`\n\u2716 ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

export const step = message => console.log(`\n\u25b8 ${message}`);

function firstMatch(candidates, marker) {
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, marker))) return candidate;
  }
  return undefined;
}

/** JAVA_HOME, or the JBR that ships inside Android Studio. */
export function resolveJavaHome() {
  return firstMatch([
    process.env.JAVA_HOME,
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Android Studio', 'jbr'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'JetBrains', 'Toolbox', 'apps', 'AndroidStudio', 'ch-0', 'jbr'),
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    '/usr/lib/jvm/java-17-openjdk-amd64',
    '/usr/lib/jvm/default-java',
  ], isWindows ? 'bin\\java.exe' : 'bin/java');
}

/** ANDROID_HOME / ANDROID_SDK_ROOT, or the default location per platform. */
export function resolveAndroidHome() {
  return firstMatch([
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    process.env.HOME && join(process.env.HOME, 'Android', 'Sdk'),
    process.env.HOME && join(process.env.HOME, 'Library', 'Android', 'sdk'),
    '/usr/lib/android-sdk',
  ], 'platform-tools');
}

/** Parses a `key=value` properties file into a plain object. */
export function readProperties(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s][^=]*)\s*=\s*(.*)$/);
    if (match) values[match[1].trim()] = match[2].trim();
  }
  return values;
}
