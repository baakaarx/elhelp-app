#!/usr/bin/env bash
# Daily-consistent backup of the live SQLite file.
#
# `VACUUM INTO` writes a single compact copy without stopping the server, and — unlike `cp` — it
# cannot capture a torn page while the server is writing.
#
# This script used to be broken: the Node snippet was passed with `-e '…'`, and the single quotes
# inside it (`VACUUM INTO '…'`) closed the shell string. Bash aborted with "unexpected EOF", the
# crontab kept running it at 02:30 every night, and there was no backup at all until the day one
# was needed. It is now a quoted heredoc, it checks what it wrote before keeping it, and it fails
# loudly (non-zero, on stderr) when anything goes wrong.
#
# Install:
#   sudo cp scripts/backup-sqlite.sh /usr/local/bin/elhelp-backup && sudo chmod +x /usr/local/bin/elhelp-backup
#   sudo crontab -e   # 30 2 * * * DB_PATH=/var/lib/elhelp/mandoub.db /usr/local/bin/elhelp-backup
set -euo pipefail

DB_PATH="${DB_PATH:-/var/lib/elhelp/mandoub.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/elhelp/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d_%H%M)"
TARGET="$BACKUP_DIR/mandoub-$STAMP.db"

if [ ! -f "$DB_PATH" ]; then
  echo "backup failed: no database at $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# Quoted heredoc: nothing here is expanded or re-quoted by the shell.
DB_PATH="$DB_PATH" TARGET="$TARGET" node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const { DB_PATH, TARGET } = process.env;
const db = new DatabaseSync(DB_PATH);
try {
  // `VACUUM INTO` takes a literal path; doubling a quote is SQL's own escape.
  db.exec(`VACUUM INTO '${TARGET.replace(/'/g, "''")}'`);
} finally {
  db.close();
}
NODE

# A copy nobody opened is a hope, not a backup: open it, check it, and only then keep it.
DB_PATH="$TARGET" node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
const path = process.env.DB_PATH;
const size = statSync(path).size;
if (size < 8192) throw new Error(`copy is ${size} bytes`);
const db = new DatabaseSync(path, { readOnly: true });
try {
  const check = db.prepare('PRAGMA integrity_check').get().integrity_check;
  if (check !== 'ok') throw new Error(`integrity_check said ${check}`);
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (!users) throw new Error('copy has no accounts');
} finally {
  db.close();
}
NODE

chmod 600 "$TARGET"
gzip -f "$TARGET"
find "$BACKUP_DIR" -name 'mandoub-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $TARGET.gz ($(du -h "$TARGET.gz" | cut -f1))"
