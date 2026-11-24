/**
 * Reads `server/.env` the way the server itself does, so a script and the box it is testing agree.
 *
 * `scripts/preview.mjs` has told operators for a while that «server/.env is fine» while only looking at
 * `process.env` — an env file the script never opens. The smoke test had the same split: the credentials
 * had to be typed twice, once for the server and once for the script, and getting one of them wrong is a
 * run that fails with `401` on the first check and points at the login code.
 *
 * Precedence is `process.loadEnvFile`'s own: a variable already exported wins over the file, so
 * `ADMIN_PASSWORD=… npm run smoke` remains the one-off override it always was.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadServerEnv() {
  // The server resolves its env file as `server/src/../.env`; this file lives in `scripts/lib`, so the
  // same directory is two levels up from here.
  const file = resolve(fileURLToPath(new URL('../..', import.meta.url)), 'server', '.env');
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}
