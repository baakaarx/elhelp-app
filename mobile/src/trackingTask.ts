import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { BACKGROUND_TASK, randomUUID } from './tracking';
import { enqueueLocation, flushOutbox } from './reports';
import { getActiveShift } from './storage';
import { MAX_ACCURACY_M } from './location';
import type { GeoPoint } from './types';

// Background fixes are queued first, then flushed: the OS may only give us a few seconds.
if (!TaskManager.isTaskDefined(BACKGROUND_TASK)) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(BACKGROUND_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    const shiftId = await getActiveShift();
    if (!shiftId) return;
    for (const position of data.locations) {
      const accuracy = position.coords.accuracy ?? null;
      // The OS also reports network guesses while a real GPS lock is pending; skip those so
      // the route does not jump across the city.
      if (accuracy != null && (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > MAX_ACCURACY_M)) continue;
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
