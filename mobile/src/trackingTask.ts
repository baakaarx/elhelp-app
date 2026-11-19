import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { BACKGROUND_TASK, randomUUID, shouldQueueFix } from './tracking';
import { enqueueLocation, flushOutbox } from './reports';
import { getActiveShift } from './storage';
import { MAX_ACCURACY_M } from './location';
import { discardCachedFixForMockLocation } from './locationCache';
import { announceMockLocation, isMockedLocation } from './locationIntegrity';
import { getDeviceId } from './device';
import { reportMockLocation } from './api';
import type { GeoPoint } from './types';

const mockReportStates = new Map<string, { lastAttemptAt: number; sent: boolean }>();

// Background fixes are queued first, then flushed: the OS may only give us a few seconds.
if (!TaskManager.isTaskDefined(BACKGROUND_TASK)) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(BACKGROUND_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    const shiftId = await getActiveShift();
    if (!shiftId) return;
    for (const position of data.locations) {
      if (isMockedLocation(position)) {
        discardCachedFixForMockLocation();
        announceMockLocation();
        const now = Date.now();
        const previous = mockReportStates.get(shiftId);
        if (!previous || (!previous.sent && now - previous.lastAttemptAt >= 60000)) {
          mockReportStates.set(shiftId, { lastAttemptAt: now, sent: false });
          void getDeviceId().then(deviceId => reportMockLocation(shiftId, deviceId))
            .then(() => {
              const state = mockReportStates.get(shiftId);
              if (state) state.sent = true;
            }).catch(() => undefined);
        }
        continue; // Do not persist or upload a fix marked simulated by the operating system.
      }
      const accuracy = position.coords.accuracy ?? null;
      const { latitude, longitude } = position.coords;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
      // The OS also reports network guesses while a real GPS lock is pending; skip those so
      // the route does not jump across the city.
      if (accuracy != null && (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > MAX_ACCURACY_M)) continue;
      // The OS delivers fixes even when the phone is still (distanceInterval: 1), so drop the
      // jitter here but let a heartbeat through every 30 s — that is what keeps a parked
      // engineer from looking like "no signal" on the manager's dashboard.
      if (!shouldQueueFix(latitude, longitude)) continue;
      const point: GeoPoint = {
        id: randomUUID(),
        shiftId,
        lat: position.coords.latitude, lng: position.coords.longitude,
        accuracy: position.coords.accuracy ?? null, speed: position.coords.speed != null && position.coords.speed >= 0 && position.coords.speed <= 150 ? position.coords.speed : null,
        heading: position.coords.heading != null && position.coords.heading >= 0 && position.coords.heading < 360 ? position.coords.heading : null, battery: null,
        recordedAt: position.timestamp || Date.now(),
      };
      await enqueueLocation(point);
    }
    await flushOutbox();
    return;
  });
}
