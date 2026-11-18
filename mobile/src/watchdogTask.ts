import { Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import { isBackgroundTracking, startBackgroundUpdates } from './tracking';
import { getActiveShift, setActiveShift } from './storage';
import { shiftState } from './api';

export const WATCHDOG_TASK = 'elhelp-tracking-watchdog';

/**
 * The OS can kill the app — or the phone can reboot — with a shift still open. The foreground
 * service cannot come back from a reboot on its own: nothing is running until something wakes
 * the app. This periodic task (WorkManager on Android, which reschedules itself after a
 * reboot) checks whether background tracking is alive and restarts it if not, so the route
 * only gaps when the phone is off, offline, or has no location fix.
 */
if (!TaskManager.isTaskDefined(WATCHDOG_TASK)) {
  TaskManager.defineTask(WATCHDOG_TASK, async () => {
    try {
      const shiftId = await getActiveShift();
      if (!shiftId) return BackgroundTask.BackgroundTaskResult.Success;
      if (await isBackgroundTracking()) return BackgroundTask.BackgroundTaskResult.Success;
      // Confirm the shift is still open when the server is reachable. Offline, assume open:
      // the server rejects points for a closed shift, but a gap in the route is worse.
      try {
        const state = await shiftState();
        if (!state.shift) { await setActiveShift(null); return BackgroundTask.BackgroundTaskResult.Success; }
      } catch { /* offline — assume open */ }
      await startBackgroundUpdates();
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

/**
 * Schedule the watchdog while background tracking is on. WorkManager persists the periodic
 * work across reboots, so tracking comes back on its own after the phone restarts.
 */
export async function scheduleWatchdog(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return;
    await BackgroundTask.registerTaskAsync(WATCHDOG_TASK, { minimumInterval: 15 });
  } catch { /* best effort — tracking still works without the watchdog */ }
}

export async function cancelWatchdog(): Promise<void> {
  if (Platform.OS === 'web') return;
  try { await BackgroundTask.unregisterTaskAsync(WATCHDOG_TASK); } catch { /* best effort */ }
}
