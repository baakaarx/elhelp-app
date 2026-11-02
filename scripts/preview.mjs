// Build once, then serve a stable demo preview (no Vite HMR / tsx watch restarts).
import { spawn, spawnSync } from 'node:child_process';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(args, env = {}) {
  const result = spawnSync(npm, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['run', 'build']);
run(['run', 'export:mobile'], { EXPO_BASE_URL: '/app' });
const child = spawn(process.execPath, ['server/dist/index.js'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development', DEMO_MODE: 'true', PORT: process.env.PORT || '5173' },
});
child.on('exit', code => process.exit(code ?? 0));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
