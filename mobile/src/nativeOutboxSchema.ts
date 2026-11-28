/** The SQLite schema is shared with node:sqlite tests; startup never prunes queued work. */
export function initializeNativeOutbox(db: {
  execSync(sql: string): unknown;
  getAllSync<T>(sql: string): T[];
}): void {
  db.execSync(`CREATE TABLE IF NOT EXISTS outbox (
    key TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0
  )`);
  const columns = db.getAllSync<{name:string}>('PRAGMA table_info(outbox)');
  if (!columns.some(column => column.name === 'rejected')) {
    try { db.execSync('ALTER TABLE outbox ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0'); }
    catch (error) {
      // A background task and foreground may upgrade concurrently. Ignore only a completed
      // migration by the other connection; do not hide a disk or database failure.
      if (!db.getAllSync<{name:string}>('PRAGMA table_info(outbox)').some(column => column.name === 'rejected')) throw error;
    }
  }
  db.execSync('CREATE TABLE IF NOT EXISTS outbox_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
  db.execSync('CREATE INDEX IF NOT EXISTS outbox_pending_location ON outbox(kind,rejected,created_at)');
}

export function nativeLocationReplaySql(includeRejected: boolean): string {
  return `SELECT key,kind,payload,created_at,attempts,rejected FROM outbox WHERE kind='location' ${includeRejected ? '' : 'AND rejected=0'} ORDER BY ${includeRejected ? 'attempts, ' : ''}created_at, rowid LIMIT ?`;
}
