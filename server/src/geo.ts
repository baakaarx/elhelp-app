
export interface GeoPoint {
  lat: number; lng: number; accuracy: number | null; speed: number | null; recordedAt: number;
}
export function haversine(a: Pick<GeoPoint, 'lat' | 'lng'>, b: Pick<GeoPoint, 'lat' | 'lng'>): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(Math.min(1, Math.max(0, h))), Math.sqrt(Math.max(0, 1 - h)));
}
// Conservative estimate, not a validated payroll or reimbursement distance.
export function distanceMeters(points: GeoPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if ((a.accuracy !== null && a.accuracy > 100) || (b.accuracy !== null && b.accuracy > 100)) continue;
    const meters = haversine(a, b), seconds = (b.recordedAt - a.recordedAt) / 1000;
    if (seconds <= 0 || seconds > 600 || meters < 10 || meters / seconds > 55) continue;
    total += meters;
  }
  return total;
}
export function dayBounds(date: string, timezone: string): { start: number; end: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date');
  const noon = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(noon.getTime()) || noon.toISOString().slice(0, 10) !== date) throw new Error('Invalid date');
  // Resolve each calendar boundary separately: a local day can be 23 or 25 hours.
  // Samples around the candidate also handle zones whose transition is at midnight.
  const midnight = (day: string) => {
    const utc = new Date(`${day}T00:00:00Z`).getTime();
    const sample = utc + 12 * 3600000;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(sample);
    const value = (type: string) => Number(parts.find(p => p.type === type)?.value);
    const offset = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second')) - sample;
    const candidate = utc - offset;
    const valid = [-3, -2, -1, 0, 1, 2, 3].map(hours => candidate + hours * 3600000).filter(time => localDate(timezone, time) === day).sort((a, b) => a - b);
    if (!valid.length) throw new Error('This calendar day does not exist in the configured timezone');
    return valid[0];
  };
  const start = midnight(date);
  const next = new Date(noon.getTime() + 86400000).toISOString().slice(0, 10);
  const end = midnight(next);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || localDate(timezone, start) !== date) throw new Error('Invalid day');
  return { start, end };
}
export function localDate(timezone: string, time = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(time);
  const value = (type: string) => parts.find(p => p.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
