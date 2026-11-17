import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const mobile = join(root, 'mobile');
const expoCli = join(root, 'node_modules', 'expo', 'bin', 'cli');

function expoConfig(apiUrl: string) {
  return spawnSync(process.execPath, [expoCli, 'config', '--type', 'public', '--json'], {
    cwd: mobile,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      EAS_BUILD: 'true',
      EAS_BUILD_PROFILE: 'production',
      EXPO_PUBLIC_API_URL: apiUrl,
    },
  });
}

test('production EAS config refuses an HTTP API endpoint', () => {
  const result = expoConfig('http://tracking.example.com');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /require an HTTPS EXPO_PUBLIC_API_URL that is not localhost/);
});

test('production EAS config refuses a loopback HTTPS endpoint', () => {
  const result = expoConfig('https://[::1]:3000');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /require an HTTPS EXPO_PUBLIC_API_URL that is not localhost/);
});

test('production EAS config accepts an HTTPS API endpoint', () => {
  const result = expoConfig('https://tracking.example.com');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.includes('https://tracking.example.com'));
});
