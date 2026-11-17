/** Shared SQLite ordering: user-entered actions first, FIFO within each priority, GPS last. */
export const OUTBOX_ORDER_BY_SQL = 'CASE WHEN kind=\'location\' THEN 1 ELSE 0 END, created_at, rowid';
