// Every browser run starts from an empty account: the suite creates its own team through the
// public API. Removing the file here (once, before Playwright loads anything) keeps the reset
// out of the config module, which Playwright can evaluate more than once per run.
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const dbPath = resolve(process.env.E2E_DB_PATH || 'server/data/e2e.db');
for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
console.log(`e2e database reset: ${dbPath}`);
