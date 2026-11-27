import type { GeoPoint, OutboxItem } from './types';
import type { Outbox } from './queue';

/** Parse by row key, preserving unreadable rows, and remove only after an acknowledged batch. */
export async function replayLocationOutbox(
  items: OutboxItem[],
  queue: Pick<Outbox, 'remove' | 'reject' | 'bump'>,
  send: (points: GeoPoint[]) => Promise<{ accepted: number; duplicates: number }>,
): Promise<number> {
  const locations: GeoPoint[] = [];
  for (const item of items) {
    if (item.kind !== 'location') continue;
    try {
      const point: unknown = JSON.parse(item.payload);
      if (!point || typeof point !== 'object' || (point as GeoPoint).id !== item.key) throw Error('invalid queued point');
      locations.push(point as GeoPoint);
    } catch { await queue.bump(item.key); await queue.reject(item.key); }
  }
  return sendLocationChunks(locations, async points => {
    const result = await send(points);
    if (!result || !Number.isInteger(result.accepted) || !Number.isInteger(result.duplicates)
        || result.accepted < 0 || result.duplicates < 0 || result.accepted + result.duplicates !== points.length) {
      throw new Error('تعذر التأكد من وصول نقاط الموقع للسيرفر.');
    }
  }, id => queue.remove(id), async id => { await queue.bump(id); await queue.reject(id); });
}

/**
 * Send accepted fixes once and isolate rejected ones. A rejected fix stays on the device, marked
 * for review/manual retry; it must not block newer fixes or be mistaken for a delivered point.
 */
export async function sendLocationChunks(
  locations: GeoPoint[],
  send: (points: GeoPoint[]) => Promise<unknown>,
  remove: (id: string) => Promise<void>,
  reject: (id: string) => Promise<void>,
): Promise<number> {
  let sent = 0;
  async function sendChunk(chunk: GeoPoint[]): Promise<boolean> {
    try {
      await send(chunk);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 0;
      // A clock problem can affect the whole batch; preserve it for automatic retry after fixing
      // the phone clock, rather than classifying every fix as individually invalid.
      if ((error as { code?: string }).code === 'CLOCK_SKEW') throw error;
      if (status !== 400 && status !== 422) return false;
      if (chunk.length === 1) { await reject(chunk[0].id); return true; }
      const middle = Math.floor(chunk.length / 2);
      return await sendChunk(chunk.slice(0, middle)) && await sendChunk(chunk.slice(middle));
    }
    // A local deletion failure is not an API rejection. Leave remaining IDs for an idempotent
    // retry instead of splitting the batch or marking already-accepted fixes as invalid.
    for (const point of chunk) await remove(point.id);
    sent += chunk.length;
    return true;
  }
  for (let i = 0; i < locations.length; i += 80) {
    if (!await sendChunk(locations.slice(i, i + 80))) break;
  }
  return sent;
}
