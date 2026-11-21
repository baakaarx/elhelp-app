import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'mandoub_token';
const CONSENT_KEY = 'mandoub_consent_at';
const SHIFT_KEY = 'mandoub_active_shift';
const OUTBOX_OWNER_KEY = 'mandoub_outbox_owner';
const ACTIVE_USER_KEY = 'mandoub_active_user';

// SecureStore has no web implementation; the packaged web build uses localStorage.
const web = Platform.OS === 'web' && typeof localStorage !== 'undefined';

export async function getToken(): Promise<string | null> {
  try {
    if (web) return localStorage.getItem(TOKEN_KEY);
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch { return null; }
}
export async function setToken(token: string | null): Promise<void> {
  try {
    if (web) { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); return; }
    if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch { /* a lost session is recoverable by signing in again */ }
}
export async function getConsentAt(): Promise<number | null> {
  try {
    const raw = web ? localStorage.getItem(CONSENT_KEY) : await SecureStore.getItemAsync(CONSENT_KEY);
    return raw ? Number(raw) : null;
  } catch { return null; }
}
export async function setConsentAt(value: number | null): Promise<void> {
  try {
    if (web) { if (value === null) localStorage.removeItem(CONSENT_KEY); else localStorage.setItem(CONSENT_KEY, String(value)); return; }
    if (value === null) await SecureStore.deleteItemAsync(CONSENT_KEY);
    else await SecureStore.setItemAsync(CONSENT_KEY, String(value));
  } catch { /* non-fatal */ }
}

async function getPrivateString(key: string): Promise<string | null> {
  try { return web ? localStorage.getItem(key) : await SecureStore.getItemAsync(key); }
  catch { return null; }
}
async function setPrivateString(key: string, value: string | null): Promise<void> {
  try {
    if (web) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); return; }
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  } catch { /* local identity hints are recoverable by signing in again */ }
}

/** Account whose unsent work is currently stored in the shared on-device outbox. */
export const getOutboxOwner = () => getPrivateString(OUTBOX_OWNER_KEY);
export const setOutboxOwner = (userId: string | null) => setPrivateString(OUTBOX_OWNER_KEY, userId);
/** Current authenticated account, also read by a headless background location task. */
export const getActiveUserId = () => getPrivateString(ACTIVE_USER_KEY);
export const setActiveUserId = (userId: string | null) => setPrivateString(ACTIVE_USER_KEY, userId);

/**
 * Removes everything this device keeps about the signed-in engineer: token, consent stamp and
 * the active shift. Used by logout and by account deletion (the store-mandated path).
 */
export async function clearDeviceData(): Promise<void> {
  await Promise.all([setToken(null), setActiveShift(null), setConsentAt(null), setActiveUserId(null)]);
}

export async function getActiveShift(): Promise<string | null> {
  try { return web ? localStorage.getItem(SHIFT_KEY) : await SecureStore.getItemAsync(SHIFT_KEY); }
  catch { return null; }
}
export async function setActiveShift(id: string | null): Promise<void> {
  try {
    if (web) { if (id) localStorage.setItem(SHIFT_KEY, id); else localStorage.removeItem(SHIFT_KEY); return; }
    if (id) await SecureStore.setItemAsync(SHIFT_KEY, id);
    else await SecureStore.deleteItemAsync(SHIFT_KEY);
  } catch { /* non-fatal */ }
}
