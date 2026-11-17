import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/db.js';

/**
 * The backup script is the one piece of the installation nobody looks at until the day they need
 * it. It runs unattended at 02:30 and its failure is silent: a mis-quoted path, a missing
 * `node:sqlite`, or a copy taken without `VACUUM INTO` produces a file that is either absent or
 * torn — and nobody finds out until the database is already gone.
 *
 * So the test does what the manager would do on the worst day: make real data, run the script,
 * unzip what it wrote, open it, and read the row back.
 */
test('the nightly backup produces a file that opens and holds the data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mandoub-backup-'));
  const dbPath = join(dir, 'live.db');
  const backups = join(dir, 'backups');
  try {
    const store = new Store(dbPath);
    store.run("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES ('u-1','مهندس','backup@test','x:y','rep',?)", Date.now());
    store.run("INSERT INTO shifts(id,user_id,started_at,consent_version,consent_at,device_id,device_name) VALUES ('s-1','u-1',?,'1.0',?,'d-1','')", Date.now(), Date.now());
    store.run("INSERT INTO locations(user_id,point_id,shift_id,lat,lng,accuracy,recorded_at,received_at,source) VALUES ('u-1','p-1','s-1',31.2,29.9,5,?,?,'gps')", Date.now(), Date.now());
    store.close();

    // Resolved from this file, not from the working directory: the suite runs from `server/`.
    const script = fileURLToPath(new URL('../../scripts/backup-sqlite.sh', import.meta.url));
    execFileSync('bash', [script], {
      env: { ...process.env, DB_PATH: dbPath, BACKUP_DIR: backups, KEEP_DAYS: '14' },
      stdio: 'pipe',
    });

    const files = readdirSync(backups).filter(name => name.endsWith('.db.gz'));
    assert.equal(files.length, 1, `expected one backup, found: ${files.join(', ') || 'none'}`);

    const copy = join(dir, 'restored.db');
    const restored = gunzipSync(readFileSync(join(backups, files[0])));
    assert.ok(restored.length > 0, 'the archive is not empty');

    // Written out and opened the way a restore would be.
    writeFileSync(copy, restored);
    const db = new DatabaseSync(copy);
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c, 1);
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM locations').get() as { c: number }).c, 1);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
