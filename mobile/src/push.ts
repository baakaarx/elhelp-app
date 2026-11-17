import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { getDeviceId } from './device';
import { disablePush, registerPushToken } from './api';

export type PushSetupResult = 'enabled' | 'denied' | 'unsupported' | 'not-configured';
let handlerInstalled = false;

function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  const value = Constants.easConfig?.projectId || extra?.eas?.projectId || '';
  return value.trim() || null;
}

async function notificationsModule() {
  // Keep web and server-rendered bundles from loading native notification APIs.
  if (Platform.OS === 'web') return null;
  return import('expo-notifications');
}

/** Register the foreground handler on every cold app start, not only after the opt-in screen. */
export async function initializePushHandling(): Promise<void> {
  const Notifications = await notificationsModule();
  if (!Notifications || handlerInstalled) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  handlerInstalled = true;
}

/** Read OS permission state without prompting. */
export async function notificationPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
  try {
    const Notifications = await notificationsModule();
    if (!Notifications) return 'unsupported';
    const result = await Notifications.getPermissionsAsync();
    return result.status === 'granted' ? 'granted' : 'denied';
  } catch { return 'unsupported'; }
}

/**
 * Explicit opt-in from Settings. Expo issues one project-scoped token that can be used for both
 * Android/FCM and iOS/APNs; the server stores it against this authenticated user and device.
 */
export async function enablePushNotifications(): Promise<PushSetupResult> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return 'unsupported';
  const id = projectId();
  // Check configuration before asking the operating system for a permission that cannot be used.
  if (!id) return 'not-configured';

  const Device = await import('expo-device');
  if (!Device.isDevice) return 'unsupported';
  const Notifications = await notificationsModule();
  if (!Notifications) return 'unsupported';

  await initializePushHandling();

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'تنبيهات المراجعة',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250, 200, 250],
      lightColor: '#1f513f',
      sound: 'default',
    });
  }

  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted') {
    permission = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: false, allowSound: true },
    });
  }
  if (permission.status !== 'granted') return 'denied';

  const token = await Notifications.getExpoPushTokenAsync({ projectId: id });
  await registerPushToken({
    token: token.data,
    platform: Platform.OS,
    deviceId: await getDeviceId(),
  });
  return 'enabled';
}

/** Stop server delivery on this signed-in device without changing the phone's OS-wide setting. */
export async function disablePushNotifications(): Promise<void> {
  if (Platform.OS === 'web') return;
  await disablePush(await getDeviceId());
}
