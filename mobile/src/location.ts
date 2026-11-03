import * as Location from 'expo-location';

export interface Fix { lat: number; lng: number; accuracy: number | null }

/** Anything worse than this is a cell-tower/network guess, not a usable field position. */
export const MAX_ACCURACY_M = 120;
/** A fix this precise is worth caching; a coarse one should be re-read next time. */
const CACHE_ACCURACY_M = 50;

/** Distance in meters between two coordinates (haversine). */
export function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(Math.min(1, Math.max(0, h))), Math.sqrt(Math.max(0, 1 - h)));
}

async function ensurePermission(): Promise<boolean> {
  try {
    const current = await Location.getForegroundPermissionsAsync();
    if (current.status === 'granted') return true;
    if (!current.canAskAgain) return false;
    const asked = await Location.requestForegroundPermissionsAsync();
    return asked.status === 'granted';
  } catch { return false; }
}

/** Turn a platform position into a fix, rejecting coordinates the GPS could not have meant. */
function toFix(position: Location.LocationObject | null): Fix | null {
  if (!position) return null;
  const { latitude, longitude, accuracy } = position.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (accuracy != null && (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > MAX_ACCURACY_M)) return null;
  return { lat: latitude, lng: longitude, accuracy: accuracy ?? null };
}

/** Never let a stalled native call block a check-in; the caller gets null and explains it. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

let cached: { fix: Fix; at: number } | null = null;

/**
 * One high-accuracy position for a check-in, a shift start or a report.
 *
 * The old version asked for a "high accuracy" reading with a 12s cap and accepted whatever
 * came back, including a 500m network estimate — that is why the pin used to jump or the
 * shift refused to start. Now: ask the GPS for its best reading, reject guesses worse than
 * 120m, fall back to a recent accurate cached fix, and retry once at medium accuracy so a
 * phone indoors still returns something usable instead of hanging.
 */
export async function captureOnce(options: { maxAgeMs?: number; timeoutMs?: number } = {}): Promise<Fix | null> {
  const maxAge = options.maxAgeMs ?? 30000;
  if (cached && Date.now() - cached.at < maxAge) return cached.fix;
  if (!(await ensurePermission())) return null;
  const budget = Math.max(4000, options.timeoutMs ?? 14000);

  const candidates: Fix[] = [];
  const precise = toFix(await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation }), budget));
  if (precise) candidates.push(precise);
  if (!precise || (precise.accuracy ?? 999) > CACHE_ACCURACY_M) {
    // A reading the OS already has (often far better indoors) beats a fresh coarse one.
    const known = toFix(await withTimeout(
      Location.getLastKnownPositionAsync({ maxAge: 120000, requiredAccuracy: MAX_ACCURACY_M }), 3000));
    if (known) candidates.push(known);
  }
  if (!candidates.length) {
    const medium = toFix(await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), Math.min(budget, 8000)));
    if (medium) candidates.push(medium);
  }
  if (!candidates.length) { cached = null; return null; }

  const best = candidates.sort((a, b) => (a.accuracy ?? 999) - (b.accuracy ?? 999))[0];
  cached = (best.accuracy ?? 999) <= CACHE_ACCURACY_M ? { fix: best, at: Date.now() } : null;
  return best;
}

export const clearLocationCache = () => { cached = null; };
