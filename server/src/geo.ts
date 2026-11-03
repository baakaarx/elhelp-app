
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
/**
 * Conservative travelled distance, not a validated payroll or reimbursement figure.
 *
 * The naive sum of consecutive fixes failed in the field: a parked phone with ±20m GPS jitter
 * "drove" several kilometers, and one bad fix dragged the total with it. Here the *step*
 * between fixes is median-filtered over a small window, so symmetric GPS noise cancels out
 * while real movement (which repeats the same direction) survives. A step is only added when
 * it is bigger than the accuracy behind it and the implied speed is humanly possible.
 */
const STEP_WINDOW = 5;
const MIN_STEP_METERS = 10;
const MAX_HUMAN_SPEED_MPS = 55; // ~200 km/h, above any field visit
const MAX_USABLE_ACCURACY_M = 100;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function distanceMeters(points: GeoPoint[]): number {
  const usable = points.filter(p => p.accuracy === null || (p.accuracy > 0 && p.accuracy <= MAX_USABLE_ACCURACY_M));
  if (usable.length < 2) return 0;
  const steps: Array<{ dLat: number; dLng: number; seconds: number }> = [];
  let total = 0;
  for (let i = 1; i < usable.length; i++) {
    const previous = usable[i - 1];
    const current = usable[i];
    const seconds = (current.recordedAt - previous.recordedAt) / 1000;
    if (seconds <= 0 || seconds > 600) { steps.length = 0; continue; }
    steps.push({ dLat: current.lat - previous.lat, dLng: current.lng - previous.lng, seconds });
    if (steps.length > STEP_WINDOW) steps.shift();
    const dLat = median(steps.map(step => step.dLat));
    const dLng = median(steps.map(step => step.dLng));
    const stepSeconds = median(steps.map(step => step.seconds));
    if (stepSeconds <= 0) continue;
    const meters = haversine(current, { lat: current.lat + dLat, lng: current.lng + dLng });
    if (meters / stepSeconds > MAX_HUMAN_SPEED_MPS) continue; // a bad fix, not a trip
    const accuracy = (( previous.accuracy ?? 0) + (current.accuracy ?? 0)) / 2;
    if (meters < Math.max(MIN_STEP_METERS, accuracy)) continue; // jitter, not movement
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
