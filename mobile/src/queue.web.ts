import type { Outbox } from './queue';
import type { OutboxItem, OutboxKind } from './types';

const KEY = 'mandoub.outbox';
function read(): OutboxItem[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') as OutboxItem[]; } catch { return []; }
}
function write(items: OutboxItem[]) { localStorage.setItem(KEY, JSON.stringify(items.slice(-500))); }

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
    async list(limit = 200) { return read().sort((a, b) => a.createdAt - b.createdAt).slice(0, limit); },
    async remove(key: string) { write(read().filter(item => item.key !== key)); },
    async bump(key: string) { write(read().map(item => (item.key === key ? { ...item, attempts: item.attempts + 1 } : item))); },
    async count() { return read().length; },
  };
}
