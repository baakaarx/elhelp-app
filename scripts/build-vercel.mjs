// Build the static bundle that Vercel serves from `public/`:
//   public/        → manager dashboard (Vite build of dashboard/)
//   public/app/    → engineer web app (Expo web export of mobile/, base path /app)
// The API itself lives in api/index.js and reuses the real Express app from server/dist.
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = join(root, 'public');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args, env = {}) {
  const result = spawnSync(npm, args, { stdio: 'inherit', cwd: root, env: { ...process.env, ...env } });
  if (result.status !== 0) {
    console.error(`\n[build:vercel] "${['npm', ...args].join(' ')}" exited with ${result.status}.`);
    process.exit(result.status ?? 1);
  }
}

const step = label => console.log(`\n[build:vercel] ${label}`);

step('1/4 building the server and the manager dashboard');
run(['run', 'build']);

step('2/4 exporting the engineer app for the web (base path /app)');
run(['run', 'export:mobile'], { EXPO_BASE_URL: '/app' });

step('3/4 assembling public/');
await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });
await cp(join(root, 'dashboard', 'dist'), publicDir, { recursive: true });
await cp(join(root, 'mobile', 'dist'), join(publicDir, 'app'), { recursive: true });

step('4/4 checking the output');
for (const [label, target] of [['manager dashboard', join(publicDir, 'index.html')], ['engineer app', join(publicDir, 'app', 'index.html')]]) {
  try {
    await readdir(join(target, '..'));
  } catch {
    console.error(`[build:vercel] missing ${label} entry: ${target}`);
    process.exit(1);
  }
}
console.log('\n[build:vercel] done — public/ is ready (dashboard at /, engineer app at /app).');
