import type { GeoPoint } from './types';

/** Split rejected batches to isolate invalid points without losing valid GPS fixes. */
export async function sendLocationChunks(
  locations: GeoPoint[],
  send: (points: GeoPoint[]) => Promise<unknown>,
  remove: (id: string) => Promise<void>,
): Promise<number> {
  let sent = 0;
  async function sendChunk(chunk: GeoPoint[]): Promise<boolean> {
    try {
      await send(chunk);
      for (const point of chunk) await remove(point.id);
      sent += chunk.length;
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status ?? 0;
      if (status !== 400 && status !== 422) return false;
      if (chunk.length === 1) { await remove(chunk[0].id); return true; }
      const middle = Math.floor(chunk.length / 2);
      return await sendChunk(chunk.slice(0, middle)) && await sendChunk(chunk.slice(middle));
    }
  }
  for (let i = 0; i < locations.length; i += 80) {
    if (!await sendChunk(locations.slice(i, i + 80))) break;
  }
  return sent;
}
