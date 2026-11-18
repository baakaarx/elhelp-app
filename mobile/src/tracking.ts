import { Platform } from 'react-native';
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import { enqueueLocation, flushOutbox } from './reports';
import { setActiveShift } from './storage';
import { MAX_ACCURACY_M, metersBetween } from './location';
import { discardCachedFixForMockLocation } from './locationCache';
import { announceMockLocation, isMockedLocation } from './locationIntegrity';
import { getDeviceId } from './device';
import { reportMockLocation } from './api';
import type { GeoPoint } from './types';

export const BACKGROUND_TASK = 'mandoub-background-location';
export const CONSENT_VERSION = '1.0';
const CHUNK_MS = 1000;
// A fix this loose is a cell-tower guess; queueing it teleports the map and inflates distance.
const MAX_POINT_ACCURACY_M = MAX_ACCURACY_M;
// While standing still the GPS jitters by a few meters, so we do not queue every fix — but a
// heartbeat still has to arrive well inside the server's staleness window (`STALE_GPS_MINUTES`,
// default 10), otherwise a stationary engineer looks like "no signal".
//
// That heartbeat only exists if the OS keeps delivering fixes while the phone is still. A
// distance filter (`distanceInterval` > 0) silences the OS completely when nobody moves, so the
// location requests below use `distanceInterval: 0` and rely on this filter to drop the jitter.
const STANDSTILL_MS = 30000;
const STANDSTILL_METERS = 5;

type Listener = (point: GeoPoint) => void;
let subscription: Location.LocationSubscription | null = null;
let shiftId: string | null = null;
let lastQueued: { lat: number; lng: number; at: number } | null = null;
let mockReportState: { shiftId: string; lastAttemptAt: number; sent: boolean } | null = null;
const listeners = new Set<Listener>();

/**
 * Shared by the foreground watcher and the background task: true when this fix is worth queueing.
 * Standing still, a fix is dropped unless the last queued one is older than the heartbeat window.
 */
export function shouldQueueFix(lat: number, lng: number, now: number = Date.now()): boolean {
  if (lastQueued && now - lastQueued.at < STANDSTILL_MS && metersBetween(lastQueued, { lat, lng }) < STANDSTILL_METERS) return false;
  lastQueued = { lat, lng, at: now };
  return true;
}

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

export async function hasForegroundPermission(): Promise<boolean> {
  try { return (await Location.getForegroundPermissionsAsync()).status === 'granted'; }
  catch { return false; }
}

export async function hasBackgroundPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try { return (await Location.getBackgroundPermissionsAsync()).status === 'granted'; }
  catch { return false; }
}

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

/** True only while the OS background location task is actually running. */
export async function isBackgroundTracking(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  return Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK).catch(() => false);
}

/**
 * Start only the OS background location task (no foreground watcher). The watchdog uses this
 * from a headless background task, where a watcher would have nothing to feed.
 */
export async function startBackgroundUpdates(): Promise<{ backgroundRunning: boolean }> {
  if (Platform.OS === 'web') return { backgroundRunning: false };
  try {
    if (!(await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK).catch(() => false))) {
      await Location.startLocationUpdatesAsync(BACKGROUND_TASK, {
        accuracy: Location.Accuracy.High,
        timeInterval: 5000,
        // 0, not 10: with a distance filter a phone lying still gets no fixes at all in the
        // background, so no heartbeat is ever queued and the manager sees "no signal" after
        // STALE_GPS_MINUTES. The standstill filter in `shouldQueueFix` drops the jitter instead.
        distanceInterval: 0,
        deferredUpdatesInterval: 5000,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: 'الهلب · تسجيل الموقع',
          notificationBody: 'يتم تسجيل موقعك أثناء الوردية. أوقف التتبع من التطبيق لإيقافه.',
          notificationColor: '#1f513f',
        },
      });
    }
    return { backgroundRunning: await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK).catch(() => false) };
  } catch {
    return { backgroundRunning: false };
  }
}

export async function startTracking(id: string, opts: { background: boolean; startedAt?: number } = { background: true }): Promise<{ backgroundRunning: boolean }> {
  shiftId = id;
  lastQueued = null;
  await setActiveShift(id);
  if (!subscription) {
    subscription = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: CHUNK_MS, distanceInterval: 0 },
      position => {
        if (isMockedLocation(position)) {
          discardCachedFixForMockLocation();
          announceMockLocation();
          const activeShift = shiftId;
          const now = Date.now();
          const previous = mockReportState;
          if (activeShift && (!previous || previous.shiftId !== activeShift || (!previous.sent && now - previous.lastAttemptAt >= 60000))) {
            // Retry after a minute if the phone was offline when the OS flag first appeared.
            mockReportState = { shiftId: activeShift, lastAttemptAt: now, sent: false };
            void getDeviceId().then(deviceId => reportMockLocation(activeShift, deviceId))
              .then(() => { if (mockReportState?.shiftId === activeShift) mockReportState.sent = true; })
              .catch(() => undefined);
          }
          return; // Never queue a location the operating system identifies as simulated.
        }
        if (!shiftId || !Number.isFinite(position.timestamp) || position.timestamp < (opts.startedAt ?? 0)) return;
        const { latitude, longitude, accuracy } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
        if (accuracy != null && (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > MAX_POINT_ACCURACY_M)) return;
        const now = Date.now();
        // Standing still: ignore the jitter but keep a heartbeat so the manager still sees a
        // live signal (otherwise a parked engineer looks like a lost connection).
        if (!shouldQueueFix(latitude, longitude, now)) return;
        const point: GeoPoint = {
          id: randomUUID(), shiftId,
          lat: latitude, lng: longitude,
          accuracy: accuracy ?? null,
          speed: position.coords.speed != null && position.coords.speed >= 0 && position.coords.speed <= 150 ? position.coords.speed : null,
          heading: position.coords.heading != null && position.coords.heading >= 0 && position.coords.heading < 360 ? position.coords.heading : null,
          battery,
          recordedAt: position.timestamp || now,
        };
        for (const listener of listeners) listener(point);
        void enqueueLocation(point).then(() => {
          if (now - lastSent > 3000) { lastSent = now; return flushOutbox(); }
        }).catch(() => undefined);
      },
    );
  }
  // The foreground service is what keeps locations flowing with the screen locked. Starting it
  // can fail (permission revoked, OS refusal) — that used to be swallowed, so the engineer
  // believed tracking was on while it died the moment the phone locked. Report the truth.
  const backgroundRunning = opts.background ? (await startBackgroundUpdates()).backgroundRunning : false;
  return { backgroundRunning };
}
export async function stopTracking() {
  shiftId = null;
  lastQueued = null;
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
