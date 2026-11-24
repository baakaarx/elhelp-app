import { randomUUID } from 'node:crypto';
import { tokenHash } from '../src/auth.js';
import type { Store } from '../src/db.js';

/**
 * One row of the office's customer book, for any test that records a visit.
 *
 * A visit is booked against a customer the office entered, so a test that checks in needs a row that
 * belongs to the rep making the request. Resolving that rep from the token is what keeps this a
 * fixture detail instead of a new argument on every helper in every file.
 *
 * Asking for the same owner and name twice returns the row that is already there — the unique index
 * that makes a duplicated customer impossible is precisely what these tests must not trip over.
 */
export function bookCustomer(store: Store, repId: string | null, name = 'عميل التجربة') {
  const existing = store.get('SELECT id FROM customers WHERE rep_id IS ? AND name=?', repId, name) as { id: string } | undefined;
  if (existing) return String(existing.id);
  const id = randomUUID();
  store.run(`INSERT INTO customers(id,rep_id,name,phone,governorate,district,stage,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, id, repId, name, '01000000000', 'الغربية', 'طنطا', 'active', Date.now(), Date.now());
  return id;
}

/** The account a bearer token belongs to — the only way a helper that gets a token can own a row. */
export const ownerIdForToken = (store: Store, token: string) =>
  String(store.get('SELECT user_id AS id FROM sessions WHERE token_hash=?', tokenHash(token))?.id || '');

export function bookForToken(store: Store, token: string, name = 'عميل التجربة') {
  return bookCustomer(store, ownerIdForToken(store, token), name);
}
