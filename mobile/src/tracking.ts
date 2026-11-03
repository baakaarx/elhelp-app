import { Platform } from 'react-native';
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import { enqueueLocation, flushOutbox } from './reports';
import { setActiveShift } from './storage';
import type { GeoPoint } from './types';

export const BACKGROUND_TASK = 'mandoub-background-location';
export const CONSENT_VERSION = '1.0';
const CHUNK_MS = 1000;

type Listener = (point: GeoPoint) => void;
let subscription: Location.LocationSubscription | null = null;
let shiftId: string | null = null;
const listeners = new Set<Listener>();

function makeId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
function randomUUID() { return makeId(); }
export { randomUUID };

export async function requestPermissions(backgroundRequested = true): Promise<{ foreground: boolean; background: boolean }> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== 'granted') return { foreground: false, background: false };
  if (Platform.OS === 'web' || !backgroundRequested) return { foreground: true, background: false };
  const background = await Location.requestBackgroundPermissionsAsync();
  return { foreground: true, background: background.status === 'granted' };
}

let lastSent = 0;
let battery: number | null = null;
export async function currentBattery(): Promise<number | null> {
  try {
    const level = await Battery.getBatteryLevelAsync();
    battery = level >= 0 ? Math.round(level * 100) : null;
    return battery;
  } catch { return battery; }
}

export async function startTracking(id: string, opts: { background: boolean; startedAt?: number } = { background: true }) {
  shiftId = id;
  await setActiveShift(id);
  if (!subscription) {
    subscription = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: CHUNK_MS, distanceInterval: 5 },
      position => {
        if (!shiftId || !Number.isFinite(position.timestamp) || position.timestamp < (opts.startedAt ?? 0)) return;
        const point: GeoPoint = {
          id: randomUUID(), shiftId,
          lat: position.coords.latitude, lng: position.coords.longitude,
          accuracy: position.coords.accuracy ?? null,
          speed: position.coords.speed != null && position.coords.speed >= 0 && position.coords.speed <= 150 ? position.coords.speed : null,
          heading: position.coords.heading != null && position.coords.heading >= 0 && position.coords.heading < 360 ? position.coords.heading : null,
          battery,
          recordedAt: position.timestamp || Date.now(),
        };
        for (const listener of listeners) listener(point);
        void enqueueLocation(point).then(() => {
          const now = Date.now();
          if (now - lastSent > 3000) { lastSent = now; return flushOutbox(); }
        }).catch(() => undefined);
      },
    );
  }
  if (opts.background && Platform.OS !== 'web' && !(await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK).catch(() => false))) {
    await Location.startLocationUpdatesAsync(BACKGROUND_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: 5000,
      distanceInterval: 10,
      deferredUpdatesInterval: 5000,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'الهلب · تسجيل الموقع',
        notificationBody: 'يتم تسجيل موقعك أثناء الوردية. أوقف التتبع من التطبيق لإيقافه.',
        notificationColor: '#1f513f',
      },
    }).catch(() => undefined);
  }
}
export async function stopTracking() {
  shiftId = null;
  await setActiveShift(null);
  subscription?.remove();
  subscription = null;
  const running = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK).catch(() => false);
  if (running) await Location.stopLocationUpdatesAsync(BACKGROUND_TASK).catch(() => undefined);
}
export function onPoint(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setBattery(value: number | null) { battery = value; }
