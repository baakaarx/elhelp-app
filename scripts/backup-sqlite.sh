#!/usr/bin/env bash
# Daily-consistent backup of the live SQLite file.
# VACUUM INTO writes a single compact copy without stopping the server (no torn pages).
# Install:
#   sudo cp scripts/backup-sqlite.sh /usr/local/bin/elhelp-backup && sudo chmod +x /usr/local/bin/elhelp-backup
#   sudo crontab -e   # 30 2 * * * /usr/local/bin/elhelp-backup
set -euo pipefail

DB_PATH="${DB_PATH:-/var/lib/elhelp/mandoub.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/elhelp/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d_%H%M)"

mkdir -p "$BACKUP_DIR"
node -e '
const { DatabaseSync } = require("node:sqlite");
const [source, target] = process.argv.slice(1);
const db = new DatabaseSync(source);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
' "$DB_PATH" "$BACKUP_DIR/mandoub-$STAMP.db"

gzip -f "$BACKUP_DIR/mandoub-$STAMP.db"
find "$BACKUP_DIR" -name 'mandoub-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $BACKUP_DIR/mandoub-$STAMP.db.gz"
