import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { BACKGROUND_TASK, currentBattery, queueableFix, randomUUID } from './tracking';
import { enqueueLocation, flushOutbox } from './reports';
import { getActiveShift } from './storage';
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
    // The foreground watcher reads the battery every few seconds; the headless task used to send
    // `null` with every fix, so a phone tracking all afternoon through this path reached the
    // manager as «البطارية —» and the low-battery warning never fired. One read per batch: the
    // OS gives a background run only seconds, and expo-battery is already a dependency.
    const batteryLevel = await currentBattery();
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
      // Same gate as the foreground watcher: network guesses above the shared limit are not
      // turned into fabricated fresh coordinates. A stillness heartbeat needs an actual usable fix.
      const fix = queueableFix(latitude, longitude, accuracy);
      if (!fix) continue;
      const point: GeoPoint = {
        id: randomUUID(),
        shiftId,
        lat: fix.lat, lng: fix.lng,
        accuracy: fix.accuracy, speed: position.coords.speed != null && position.coords.speed >= 0 && position.coords.speed <= 150 ? position.coords.speed : null,
        heading: position.coords.heading != null && position.coords.heading >= 0 && position.coords.heading < 360 ? position.coords.heading : null, battery: batteryLevel,
        recordedAt: position.timestamp || Date.now(),
      };
      // If storage is full, enqueueLocation records a warning. Still attempt to flush the
      // already-saved backlog below: otherwise the background task cannot free any space until
      // the engineer opens the app. Do not claim this or the rest of the batch was saved.
      try { await enqueueLocation(point); } catch { break; }
    }
    await flushOutbox();
    return;
  });
}
