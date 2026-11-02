import * as Location from 'expo-location';

export interface Fix { lat: number; lng: number; accuracy: number | null }

/** One-shot high-accuracy fix, with a short cache so a burst of actions does not spam GPS. */
let cached: { fix: Fix; at: number } | null = null;
export async function captureOnce(options: { maxAgeMs?: number } = {}): Promise<Fix | null> {
  const maxAge = options.maxAgeMs ?? 30000;
  if (cached && Date.now() - cached.at < maxAge) return cached.fix;
  try {
    const permission = await Location.getForegroundPermissionsAsync();
    if (permission.status !== 'granted') {
      const asked = await Location.requestForegroundPermissionsAsync();
      if (asked.status !== 'granted') return null;
    }
    const position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 12000)),
    ]);
    if (!position) return cached?.fix ?? null;
    const fix: Fix = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy ?? null,
    };
    cached = { fix, at: Date.now() };
    return fix;
  } catch { return cached?.fix ?? null; }
}
export const clearLocationCache = () => { cached = null; };
