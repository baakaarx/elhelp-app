import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { BACKGROUND_TASK } from './tracking';
import { enqueueLocation, flushOutbox } from './reports';
import { getActiveShift } from './storage';
import type { GeoPoint } from './types';

// Background fixes are queued first, then flushed: the OS may only give us a few seconds.
if (!TaskManager.isTaskDefined(BACKGROUND_TASK)) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(BACKGROUND_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    const shiftId = await getActiveShift();
    if (!shiftId) return;
    for (const position of data.locations) {
      const point: GeoPoint = {
        id: position.coords.latitude.toString(36) + position.timestamp.toString(36) + Math.random().toString(36).slice(2, 8),
        shiftId,
        lat: position.coords.latitude, lng: position.coords.longitude,
        accuracy: position.coords.accuracy ?? null, speed: position.coords.speed ?? null,
        heading: position.coords.heading ?? null, battery: null,
        recordedAt: position.timestamp || Date.now(),
      };
      await enqueueLocation(point);
    }
    await flushOutbox();
    return;
  });
}
