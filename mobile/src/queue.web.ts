import { assertSameQueuedAction, outboxKey } from './outboxKey';
import { outboxOwnership } from './outboxOwnership';
import type { Outbox } from './queue';
import type { OutboxItem, OutboxKind } from './types';

const KEY = 'mandoub.outbox';
const OWNER_KEY = 'mandoub_outbox_owner';
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

function append(kind: OutboxKind, payload: unknown, items = read()) {
  const key = outboxKey(kind, payload), serialized = JSON.stringify(payload);
  const existing = items.find(item => item.key === key);
  if (existing) assertSameQueuedAction(existing, kind, serialized);
  else { items.push({ key, kind, payload: serialized, createdAt: Date.now(), attempts: 0, rejected: false }); write(items); }
}

function replayItems(items: OutboxItem[], limit: number, includeRejected: boolean) {
  items.sort((a, b) => a.createdAt - b.createdAt);
  const points = items.filter(item => item.kind === 'location' && (includeRejected || !item.rejected));
  if (includeRejected) points.sort((a,b) => a.attempts-b.attempts || a.createdAt-b.createdAt);
  return [...items.filter(item => item.kind !== 'location'), ...points.slice(0, limit)];
}
export async function createQueue(): Promise<Outbox> {
  return {
    async add(kind: OutboxKind, payload: unknown) {
      await mutate(() => append(kind, payload));
    },
    async addOwned(kind: OutboxKind, payload: unknown, owner: string, _legacyOwner: string | null) {
      await mutate(() => {
        const items = read();
        const savedOwner = localStorage.getItem(OWNER_KEY);
        const ownership = outboxOwnership(savedOwner, owner, items.length);
        if (!ownership.allowed) throw new Error(`${ownership.notice || 'لا يمكن إضافة البيانات إلى قائمة المزامنة الحالية.'} لم يُحفظ الطلب الجديد.`);
        if (!items.length) {
          try { localStorage.setItem(OWNER_KEY, owner); }
          catch { throw new Error('تعذر تسجيل ملكية البيانات المحفوظة على هذا الهاتف؛ لم نحفظ الطلب.'); }
        }
        append(kind, payload, items);
      });
    },
    async owner(_legacyOwner: string | null) { try { return localStorage.getItem(OWNER_KEY); } catch { throw new Error(READ_ERROR); } },
    async snapshot(_legacyOwner: string | null, locationLimit = 200, includeRejectedLocations = false) {
      return mutate(() => { const items = read(); return {owner: localStorage.getItem(OWNER_KEY), count: items.length, items: replayItems(items, locationLimit, includeRejectedLocations)}; });
    },
    async list(limit = 200) {
      const items = read().sort((a, b) => a.createdAt - b.createdAt);
      // Reports first: see queue.native.ts — a GPS backlog must not starve them.
      return [...items.filter(item => item.kind !== 'location'), ...items.filter(item => item.kind === 'location')].slice(0, limit);
    },
    async listForReplay(locationLimit = 200, includeRejectedLocations = false) {
      return replayItems(read(), locationLimit, includeRejectedLocations);
    },
    async countRejectedLocations() { return read().filter(item => item.kind === 'location' && item.rejected).length; },
    async remove(key: string) { await mutate(() => write(read().filter(item => item.key !== key))); },
    async bump(key: string) { await mutate(() => write(read().map(item => (item.key === key ? { ...item, attempts: item.attempts + 1 } : item)))); },
    async reject(key: string) { await mutate(() => write(read().map(item => (item.key === key ? { ...item, rejected: true } : item)))); },
    async unreject(key: string) { await mutate(() => write(read().map(item => (item.key === key ? { ...item, rejected: false } : item)))); },
    async count(kind?: OutboxKind) { return kind ? read().filter(item => item.kind === kind).length : read().length; },
    async clear() { await mutate(() => { read(); write([]); }); },
    async clearOwned(owner: string) { return mutate(() => { const items = read(); if (items.length && localStorage.getItem(OWNER_KEY) !== owner) return false; write([]); return true; }); },
  };
}
