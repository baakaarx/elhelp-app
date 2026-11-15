
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

/**
 * Median of the first `count` slots, sorted in place on a scratch buffer.
 *
 * The window never holds more than five values, and this runs three times per GPS fix — for a
 * month's register that is millions of calls, so it allocates nothing and does not use the
 * generic sort the first version called (which dominated the cost of every KPI export).
 */
function medianOf(slots: number[], count: number, scratch: number[]): number {
  for (let index = 0; index < count; index++) scratch[index] = slots[index];
  for (let index = 1; index < count; index++) {
    const value = scratch[index];
    let cursor = index - 1;
    while (cursor >= 0 && scratch[cursor] > value) { scratch[cursor + 1] = scratch[cursor]; cursor--; }
    scratch[cursor + 1] = value;
  }
  const middle = count >> 1;
  return count % 2 ? scratch[middle] : (scratch[middle - 1] + scratch[middle]) / 2;
}

export function distanceMeters(points: GeoPoint[]): number {
  const usable = points.filter(p => p.accuracy === null || (p.accuracy > 0 && p.accuracy <= MAX_USABLE_ACCURACY_M));
  if (usable.length < 2) return 0;
  // Fixed windows instead of an array of objects: the same numbers, built without allocating.
  const latSteps = new Array<number>(STEP_WINDOW).fill(0);
  const lngSteps = new Array<number>(STEP_WINDOW).fill(0);
  const secondsSteps = new Array<number>(STEP_WINDOW).fill(0);
  const scratch = new Array<number>(STEP_WINDOW).fill(0);
  const stepScratch = new Array<number>(STEP_WINDOW).fill(0);
  let count = 0;
  let total = 0;
  for (let index = 1; index < usable.length; index++) {
    const previous = usable[index - 1];
    const current = usable[index];
    const seconds = (current.recordedAt - previous.recordedAt) / 1000;
    if (seconds <= 0 || seconds > 600) { count = 0; continue; }
    if (count === STEP_WINDOW) {
      // Drop the oldest of the five so the newest fits.
      for (let slot = 0; slot < STEP_WINDOW - 1; slot++) {
        latSteps[slot] = latSteps[slot + 1];
        lngSteps[slot] = lngSteps[slot + 1];
        secondsSteps[slot] = secondsSteps[slot + 1];
      }
      count = STEP_WINDOW - 1;
    }
    latSteps[count] = current.lat - previous.lat;
    lngSteps[count] = current.lng - previous.lng;
    secondsSteps[count] = seconds;
    count++;
    const dLat = medianOf(latSteps, count, scratch);
    const dLng = medianOf(lngSteps, count, scratch);
    const stepSeconds = medianOf(secondsSteps, count, stepScratch);
    if (stepSeconds <= 0) continue;
    const meters = haversine(current, { lat: current.lat + dLat, lng: current.lng + dLng });
    if (meters / stepSeconds > MAX_HUMAN_SPEED_MPS) continue; // a bad fix, not a trip
    const accuracy = ((previous.accuracy ?? 0) + (current.accuracy ?? 0)) / 2;
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
