import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const DEVICE_KEY = 'mandoub_device_id';
const DEVICE_NAME_KEY = 'mandoub_device_name';

function randomId() {
  // fallback UUID v4 without crypto dependency
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export async function getDeviceId(): Promise<string> {
  const web = Platform.OS === 'web' && typeof localStorage !== 'undefined';
  try {
    let id: string | null = null;
    if (web) id = localStorage.getItem(DEVICE_KEY);
    else id = await SecureStore.getItemAsync(DEVICE_KEY);
    if (id && id.trim().length >= 3) return id;
    const fresh = `${Platform.OS}-${randomId()}`;
    if (web) localStorage.setItem(DEVICE_KEY, fresh);
    else await SecureStore.setItemAsync(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    return `${Platform.OS}-${randomId()}`;
  }
}

export async function getDeviceName(): Promise<string> {
  const web = Platform.OS === 'web' && typeof navigator !== 'undefined';
  try {
    if (web) return navigator.userAgent.slice(0, 80);
    const { default: Constants } = await import('expo-constants');
    return String((Constants as any).deviceName || Platform.OS || '').slice(0, 80);
  } catch { return Platform.OS; }
}
