#!/usr/bin/env node
/** Export the engineer client under /app; API requests remain same-origin and relative. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const mobileRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDir = fileURLToPath(new URL('../dist/', import.meta.url));
const expoCli = fileURLToPath(new URL('../../node_modules/expo/bin/cli', import.meta.url));
const result = spawnSync(process.execPath, [expoCli, 'export', '--platform', 'web', '--output-dir', 'dist'], {
  cwd: mobileRoot,
  // The iPhone site is served from its own origin. Keeping API URLs relative means it uses that
  // origin's /api routes and does not depend on CORS or accidentally inherit a native app URL.
  env: { ...process.env, EXPO_BASE_URL: '/app', EXPO_PUBLIC_API_URL: '', EXPO_WEB_EXPORT: 'true' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const index = `${outputDir}index.html`;
if (!existsSync(index)) throw new Error(`Expo web export did not produce ${index}`);
let html = readFileSync(index, 'utf8');
const localizedHtml = html.replace('<html lang="en">', '<html lang="ar" dir="rtl">');
if (localizedHtml === html) throw new Error('Could not set the engineer page language and direction to Arabic.');
html = localizedHtml;
writeFileSync(index, html);
if (!html.includes('الهلب جروب') || !html.includes('مهندس')) {
  throw new Error('The exported engineer page is missing its expected title.');
}
if (!/src="\/app\/[^\"]+\.js"/.test(html)) {
  throw new Error('The exported JavaScript must use the /app/ base path.');
}
if (/\b(?:src|href)="\/(?!app\/|favicon\.ico)[^\"]+"/.test(html)) {
  throw new Error('The exported engineer page contains an asset URL outside /app/.');
}
console.log('Engineer web export is ready at mobile/dist and mounted at /app/.');
