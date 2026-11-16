import type { Outbox } from './queue';
import type { OutboxItem, OutboxKind } from './types';

const KEY = 'mandoub.outbox';
function read(): OutboxItem[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') as OutboxItem[]; } catch { return []; }
}
const MAX_ITEMS = 500;
/**
 * The cap used to be a plain `slice(-500)`, so a long offline stretch of fixes could silently
 * evict a queued report — the engineer's actual work. Fixes are dropped first now.
 */
function trim(items: OutboxItem[]) {
  let overflow = items.length - MAX_ITEMS;
  if (overflow <= 0) return items;
  const kept: OutboxItem[] = [];
  for (const item of items) {
    if (item.kind === 'location' && overflow > 0) { overflow--; continue; }
    kept.push(item);
  }
  return kept.length > MAX_ITEMS ? kept.slice(-MAX_ITEMS) : kept;
}
function write(items: OutboxItem[]) {
  try { localStorage.setItem(KEY, JSON.stringify(trim(items))); }
  catch {
    // Quota exceeded: keep the reports and let the fixes go rather than losing both.
    try { localStorage.setItem(KEY, JSON.stringify(items.filter(item => item.kind !== 'location'))); } catch { /* Nothing left to hold on to. */ }
  }
}

export async function createQueue(): Promise<Outbox> {
  return {
    async add(kind: OutboxKind, payload: unknown) {
      const item = payload as { id: string };
      const items = read();
      if (!items.some(existing => existing.key === item.id)) {
        items.push({ key: item.id, kind, payload: JSON.stringify(payload), createdAt: Date.now(), attempts: 0 });
        write(items);
      }
    },
    async list(limit = 200) {
      const items = read().sort((a, b) => a.createdAt - b.createdAt);
      // Reports first: see queue.native.ts — a GPS backlog must not starve them.
      return [...items.filter(item => item.kind !== 'location'), ...items.filter(item => item.kind === 'location')].slice(0, limit);
    },
    async remove(key: string) { write(read().filter(item => item.key !== key)); },
    async bump(key: string) { write(read().map(item => (item.key === key ? { ...item, attempts: item.attempts + 1 } : item))); },
    async count() { return read().length; },
    async clear() { write([]); },
  };
}
