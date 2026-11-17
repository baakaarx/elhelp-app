/**
 * Location fields the native OS attaches to a position. Expo forwards `mocked` from Android's
 * mock-provider flag and iOS's simulated-location bit; it is optional on platforms/builds that do
 * not expose it. Keep the decision here free of React Native imports so it can be unit-tested on
 * the server-side CI runner too.
 */
export interface NativeLocationLike {
  mocked?: boolean;
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
  };
}

export interface TrustedFix {
  lat: number;
  lng: number;
  accuracy: number | null;
}

export const MOCK_LOCATION_MESSAGE = 'اكتشف الهاتف أن الموقع مُحاكى. أوقف تطبيق تغيير الموقع أو إعداد الموقع الوهمي، ثم أعد المحاولة.';

/** `undefined` means the OS supplied no mock-location verdict; only an explicit true is rejected. */
export function isMockedLocation(position: { mocked?: boolean } | null | undefined): boolean {
  return position?.mocked === true;
}

/** Validate coordinates and accuracy, and never turn a system-flagged simulated fix into GPS. */
export function trustedFix(position: NativeLocationLike | null, maxAccuracyM: number): TrustedFix | null {
  if (!position || isMockedLocation(position)) return null;
  const { latitude, longitude, accuracy } = position.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (accuracy != null && (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > maxAccuracyM)) return null;
  return { lat: latitude, lng: longitude, accuracy };
}

const mockLocationListeners = new Set<() => void>();
let lastMockNoticeAt = 0;
/** Tell the foreground UI about a native mock flag, throttled so a one-second GPS stream can't spam alerts. */
export function announceMockLocation(): void {
  const now = Date.now();
  if (now - lastMockNoticeAt < 60_000) return;
  lastMockNoticeAt = now;
  for (const listener of mockLocationListeners) {
    try { listener(); } catch { /* one UI observer must not interrupt location tracking */ }
  }
}

export function onMockLocationDetected(listener: () => void): () => void {
  mockLocationListeners.add(listener);
  return () => { mockLocationListeners.delete(listener); };
}
