// The dashboard ships the same Arabic family the mobile app uses. The font files live in
// node_modules (they are already a dependency of the workspace), so copy the three weights
// we need into public/fonts instead of committing ~600KB of TTF to the repository.
import { copyFile, mkdir, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'public', 'fonts');
const weights = [
  ['400Regular/NotoNaskhArabic_400Regular.ttf', 'NotoNaskhArabic-400.ttf'],
  ['500Medium/NotoNaskhArabic_500Medium.ttf', 'NotoNaskhArabic-500.ttf'],
  ['700Bold/NotoNaskhArabic_700Bold.ttf', 'NotoNaskhArabic-700.ttf'],
];

const require = createRequire(import.meta.url);
let fontRoot;
try {
  fontRoot = dirname(require.resolve('@expo-google-fonts/noto-naskh-arabic/package.json'));
} catch {
  console.warn('[copy-fonts] Arabic font package not installed — the dashboard falls back to system fonts.');
  process.exit(0);
}
await mkdir(output, { recursive: true });
for (const [source, target] of weights) {
  const from = join(fontRoot, source);
  try {
    await access(from);
    await copyFile(from, join(output, target));
  } catch {
    console.warn(`[copy-fonts] missing ${source}`);
  }
}
console.log('[copy-fonts] Arabic font weights copied to public/fonts');

// Cairo gives the administrative interface a clear, contemporary Arabic UI face.
try {
  const cairoRoot = dirname(require.resolve('@expo-google-fonts/cairo/package.json'));
  for (const [source, target] of [
    ['400Regular/Cairo_400Regular.ttf', 'Cairo-400.ttf'],
    ['600SemiBold/Cairo_600SemiBold.ttf', 'Cairo-600.ttf'],
    ['700Bold/Cairo_700Bold.ttf', 'Cairo-700.ttf'],
  ]) await copyFile(join(cairoRoot, source), join(output, target));
} catch { console.warn('[copy-fonts] Cairo unavailable — dashboard will use its fallback font.'); }
