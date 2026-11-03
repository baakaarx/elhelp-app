import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'mandoub_token';
const CONSENT_KEY = 'mandoub_consent_at';
const SHIFT_KEY = 'mandoub_active_shift';
// Signed by the server (hosted demo only): lets any instance recognise an open shift.
const SHIFT_TOKEN_KEY = 'mandoub_shift_token';

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
export async function setConsentAt(value: number): Promise<void> {
  try {
    if (web) localStorage.setItem(CONSENT_KEY, String(value));
    else await SecureStore.setItemAsync(CONSENT_KEY, String(value));
  } catch { /* non-fatal */ }
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

export async function getShiftToken(): Promise<string | null> {
  try { return web ? localStorage.getItem(SHIFT_TOKEN_KEY) : await SecureStore.getItemAsync(SHIFT_TOKEN_KEY); }
  catch { return null; }
}
export async function setShiftToken(token: string | null): Promise<void> {
  try {
    if (web) { if (token) localStorage.setItem(SHIFT_TOKEN_KEY, token); else localStorage.removeItem(SHIFT_TOKEN_KEY); return; }
    if (token) await SecureStore.setItemAsync(SHIFT_TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(SHIFT_TOKEN_KEY);
  } catch { /* non-fatal */ }
}
