import { assertSameQueuedAction, outboxKey } from './outboxKey';
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
// localStorage writes are atomic. Never evict an existing GPS point to make room: on quota
// failure the previous queue remains intact and the caller must report the failed new write.
function write(items: OutboxItem[]) {
  try { localStorage.setItem(KEY, JSON.stringify(items)); }
  catch { throw new Error('مساحة حفظ البيانات على الهاتف ممتلئة؛ لم يتم حفظ البيانات الجديدة. أرسل البيانات المعلقة أو فرّغ مساحة ثم أعد المحاولة.'); }
}

// All tabs running this version must hold the same browser-wide lock around read/modify/write.
// Fail closed where Web Locks is unavailable (notably insecure remote HTTP): never overwrite work.
async function mutate<T>(fn: () => T): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks?.request)
    throw new Error('المتصفح لا يدعم حماية البيانات المعلقة. لم نغيّر البيانات؛ استخدم اتصال HTTPS موثوقًا واطلب المساعدة، ولا تحذف بيانات المتصفح.');
  return navigator.locks.request('mandoub.outbox.write.v1', { mode: 'exclusive' }, fn);
}

export async function createQueue(): Promise<Outbox> {
  return {
    async add(kind: OutboxKind, payload: unknown) {
      const key = outboxKey(kind, payload);
      return mutate(() => {
        const items = read();
        const serialized = JSON.stringify(payload);
        const existing = items.find(item => item.key === key);
        if (existing) assertSameQueuedAction(existing, kind, serialized);
        else {
          items.push({ key, kind, payload: serialized, createdAt: Date.now(), attempts: 0, rejected: false });
          write(items);
        }
      });
    },
    async list(limit = 200) {
      const items = read().sort((a, b) => a.createdAt - b.createdAt);
      // Reports first: see queue.native.ts — a GPS backlog must not starve them.
      return [...items.filter(item => item.kind !== 'location'), ...items.filter(item => item.kind === 'location')].slice(0, limit);
    },
    async listForReplay(locationLimit = 200, includeRejectedLocations = false) {
      const items = read().sort((a, b) => a.createdAt - b.createdAt);
      const points = items.filter(item => item.kind === 'location' && (includeRejectedLocations || !item.rejected));
      if (includeRejectedLocations) points.sort((a,b) => a.attempts-b.attempts || a.createdAt-b.createdAt);
      return [...items.filter(item => item.kind !== 'location'), ...points.slice(0, locationLimit)];
    },
    async countRejectedLocations() { return read().filter(item => item.kind === 'location' && item.rejected).length; },
    async remove(key: string) { await mutate(() => write(read().filter(item => item.key !== key))); },
    async bump(key: string) { await mutate(() => write(read().map(item => (item.key === key ? { ...item, attempts: item.attempts + 1 } : item)))); },
    async reject(key: string) { await mutate(() => write(read().map(item => (item.key === key ? { ...item, rejected: true } : item)))); },
    async unreject(key: string) { await mutate(() => write(read().map(item => (item.key === key ? { ...item, rejected: false } : item)))); },
    async count(kind?: OutboxKind) { return kind ? read().filter(item => item.kind === kind).length : read().length; },
    async clear() { await mutate(() => { read(); write([]); }); },
  };
}
