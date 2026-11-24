// Build once, then serve both web surfaces from one stable preview (no Vite HMR / tsx watch restarts).
// Credentials come from the environment/.env exactly like a real deployment: there is no
// built-in account to fall back on.
import { spawn, spawnSync } from 'node:child_process';
import { loadServerEnv } from './lib/local-env.mjs';
// The message below promises server/.env, so this loads it — otherwise the promise is a step that fails
// for the one person who followed the instruction.
loadServerEnv();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(args, env = {}) {
  const result = spawnSync(npm, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (server/.env is fine) before running the preview.');
  process.exit(1);
}
run(['run', 'build']);
const child = spawn(process.execPath, ['server/dist/index.js'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development', PORT: process.env.PORT || '5173' },
});
child.on('exit', code => process.exit(code ?? 0));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
