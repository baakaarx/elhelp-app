import { outboxKey } from './outboxKey';
import type { Outbox } from './queue';
import type { OutboxItem, OutboxKind } from './types';

const KEY = 'mandoub.outbox';
const READ_ERROR = 'تعذّر قراءة البيانات المعلّقة على هذا الهاتف؛ لم نمسحها. لا تحذف بيانات التطبيق أو المتصفح، واطلب المساعدة قبل المتابعة.';
const KINDS = new Set<OutboxKind>(['location', 'report', 'daily-report', 'visit-checkin', 'visit-checkout', 'order']);

function isOutboxItem(value: unknown): value is OutboxItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<OutboxItem>;
  return typeof item.key === 'string' && item.key.length > 0
    && typeof item.kind === 'string' && KINDS.has(item.kind as OutboxKind)
    && typeof item.payload === 'string'
    && typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
    && typeof item.attempts === 'number' && Number.isFinite(item.attempts) && item.attempts >= 0
    && (item.rejected === undefined || typeof item.rejected === 'boolean');
}

function read(): OutboxItem[] {
  let raw: string | null;
  try { raw = localStorage.getItem(KEY); }
  catch { throw new Error(READ_ERROR); }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isOutboxItem)) throw new Error('invalid outbox');
    return parsed;
  } catch { throw new Error(READ_ERROR); }
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
  // If there are more than 500 non-location actions, keep them all rather than silently deleting
  // an engineer's work. The item count is a soft cap; storage quota errors are surfaced below.
  return kept;
}
function write(items: OutboxItem[]) {
  try { localStorage.setItem(KEY, JSON.stringify(trim(items))); }
  catch {
    // Quota exceeded: keep the reports and visits, and let low-priority GPS fixes go first.
    try { localStorage.setItem(KEY, JSON.stringify(items.filter(item => item.kind !== 'location'))); }
    catch { throw new Error('مساحة حفظ البيانات على الهاتف ممتلئة؛ لم يتم حفظ الطلب. أرسل البيانات المعلقة أو فرّغ مساحة ثم أعد المحاولة.'); }
  }
}

export async function createQueue(): Promise<Outbox> {
  return {
    async add(kind: OutboxKind, payload: unknown) {
      const key = outboxKey(kind, payload);
      const items = read();
      if (!items.some(existing => existing.key === key)) {
        items.push({ key, kind, payload: JSON.stringify(payload), createdAt: Date.now(), attempts: 0, rejected: false });
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
    async reject(key: string) { write(read().map(item => (item.key === key ? { ...item, rejected: true } : item))); },
    async unreject(key: string) { write(read().map(item => (item.key === key ? { ...item, rejected: false } : item))); },
    async count(kind?: OutboxKind) { return kind ? read().filter(item => item.kind === kind).length : read().length; },
    async clear() { write([]); },
  };
}
