import { Platform } from 'react-native';
import Constants from 'expo-constants';

/**
 * Battery setup helpers for the consent sheet.
 *
 * The app cannot exempt itself from battery optimization on its own — Android requires the
 * engineer to tap "Allow" in the system dialog. These helpers open the right system screens
 * so setup is two taps instead of hunting through Settings. Samsung's "never sleeping apps"
 * list has no API at all, so that step stays as written instructions.
 *
 * `expo-intent-launcher` is loaded lazily on purpose: its JS entry calls
 * `requireNativeModule('ExpoIntentLauncher')` the moment it is imported. A static import
 * here would run that at app startup (App → HomeScreen → battery), so a build whose native
 * module failed to link would crash on launch — before any screen renders. Loading it only
 * when the engineer actually taps the battery button keeps the app alive either way.
 */

function packageName(): string {
  return Constants.expoConfig?.android?.package ?? 'com.elhelb.mandoub';
}

type IntentLauncher = typeof import('expo-intent-launcher');

/** One-tap system dialog exempting the app from battery optimization. */
export async function openBatteryExemption(): Promise<void> {
  if (Platform.OS === 'web') return;
  const IntentLauncher: IntentLauncher = await import('expo-intent-launcher');
  await IntentLauncher.startActivityAsync('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', {
    data: `package:${packageName()}`,
  });
}

/** The system list of apps with their battery-optimization status. */
export async function openBatterySettings(): Promise<void> {
  if (Platform.OS === 'web') return;
  const IntentLauncher: IntentLauncher = await import('expo-intent-launcher');
  await IntentLauncher.startActivityAsync('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
}
