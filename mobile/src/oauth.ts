import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as AppleAuthentication from 'expo-apple-authentication';

/**
 * Social sign-in on native phones and the iPhone engineer website.
 *
 * The app never sees a client secret: Google and Apple hand it a signed ID token and the
 * company server (server/src/oauth.ts) decides whether that token is real and whether the
 * person behind it has an account. Buttons stay hidden unless the server and current platform
 * both have the configuration needed to complete the flow.
 */

const GOOGLE = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
};
const APPLE_WEB_CLIENT_ID = (process.env.EXPO_PUBLIC_APPLE_WEB_CLIENT_ID || '').trim();
const APPLE_JS = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';

type AppleWebCredential = {
  authorization?: { id_token?: string };
  user?: { name?: { firstName?: string; lastName?: string }; email?: string };
};
type AppleWebSdk = {
  auth: {
    init: (options: { clientId: string; scope: string; redirectURI: string; usePopup: boolean }) => void;
    signIn: () => Promise<AppleWebCredential>;
  };
};
declare global {
  interface Window { AppleID?: AppleWebSdk }
}

let appleScriptPromise: Promise<AppleWebSdk> | null = null;
let appleInitializedFor = '';

function loadAppleSdk(): Promise<AppleWebSdk> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('تسجيل الدخول بـ Apple من المتصفح غير متاح هنا.'));
  }
  if (window.AppleID) return Promise.resolve(window.AppleID);
  if (!appleScriptPromise) {
    appleScriptPromise = new Promise<AppleWebSdk>((resolve, reject) => {
      let script = document.querySelector<HTMLScriptElement>(`script[src="${APPLE_JS}"]`);
      const created = !script;
      if (!script) {
        script = document.createElement('script');
        script.src = APPLE_JS;
        script.async = true;
      }
      script.addEventListener('load', () => window.AppleID ? resolve(window.AppleID) : reject(new Error('تعذر تحميل تسجيل الدخول بـ Apple.')), { once: true });
      script.addEventListener('error', () => reject(new Error('تعذر تحميل تسجيل الدخول بـ Apple.')), { once: true });
      if (window.AppleID) resolve(window.AppleID);
      else if (created) document.head.appendChild(script);
    }).catch(error => {
      appleScriptPromise = null;
      throw error;
    });
  }
  return appleScriptPromise;
}

/**
 * One Google client per platform, all registered in the same Google Cloud project. A token
 * minted for each iOS, Android, or browser client has a different `aud`, so the server accepts
 * the explicit list in GOOGLE_CLIENT_IDS.
 */
function googleClientId(): string {
  const ios = (process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '').trim();
  const android = (process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || '').trim();
  const web = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || '').trim();
  if (Platform.OS === 'ios') return ios || web;
  if (Platform.OS === 'android') return android || web;
  return web;
}

/** Google needs a build-time client id; without one the button would only fail on tap. */
export const googleConfigured = googleClientId().length > 0;

/** Load Apple's web SDK only when the server has enabled Apple for this engineer account. */
export async function appleAvailable(): Promise<boolean> {
  if (Platform.OS === 'web') {
    if (!APPLE_WEB_CLIENT_ID) return false;
    try { await loadAppleSdk(); return true; } catch { return false; }
  }
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

function cancelled(): Error {
  return new Error('تم إلغاء تسجيل الدخول.');
}

function googleRedirectUri(): string {
  if (Platform.OS !== 'web') return AuthSession.makeRedirectUri({ scheme: 'elhelbmandoob', path: 'oauth' });
  if (typeof window === 'undefined') throw new Error('تسجيل الدخول بـ Google من المتصفح غير متاح هنا.');
  // Registered in Google Cloud as an authorized redirect URI. The server's /app SPA fallback
  // loads maybeCompleteAuthSession on this same-origin popup callback.
  return new URL('/app/oauth', window.location.origin).toString();
}

export async function signInWithGoogle(): Promise<{ idToken: string }> {
  if (!googleConfigured) throw new Error('تسجيل الدخول بـ Google غير مهيّأ في النسخة دي.');
  const request = new AuthSession.AuthRequest({
    clientId: googleClientId(),
    responseType: AuthSession.ResponseType.IdToken,
    scopes: ['openid', 'profile', 'email'],
    // Must be registered in the Google Cloud console as an authorized redirect URI.
    redirectUri: googleRedirectUri(),
    extraParams: { prompt: 'select_account' },
  });
  const result = await request.promptAsync(GOOGLE, { showInRecents: true });
  if (result.type !== 'success') throw cancelled();
  const idToken = result.params.id_token;
  if (!idToken) throw new Error('جوجل مرجّعش رمز دخول صالح. جرّب تاني.');
  return { idToken };
}

export async function signInWithApple(): Promise<{ idToken: string; name?: string }> {
  if (Platform.OS === 'web') {
    if (!APPLE_WEB_CLIENT_ID) throw new Error('تسجيل الدخول بـ Apple غير مهيّأ لموقع المهندسين.');
    const sdk = await loadAppleSdk();
    const redirectURI = new URL('/app/oauth/apple', window.location.origin).toString();
    const configKey = `${APPLE_WEB_CLIENT_ID}|${redirectURI}`;
    if (appleInitializedFor !== configKey) {
      sdk.auth.init({ clientId: APPLE_WEB_CLIENT_ID, scope: 'name email', redirectURI, usePopup: true });
      appleInitializedFor = configKey;
    }
    let response: AppleWebCredential;
    try {
      response = await sdk.auth.signIn();
    } catch (error) {
      const code = String((error as { code?: string; error?: string })?.code || (error as { error?: string })?.error || '');
      if (/cancel|closed/i.test(code)) throw cancelled();
      throw error;
    }
    const idToken = response.authorization?.id_token;
    if (!idToken) throw new Error('Apple مرجّعش رمز دخول صالح. جرّب تاني.');
    const name = [response.user?.name?.firstName, response.user?.name?.lastName]
      .map(part => (part || '').trim()).filter(Boolean).join(' ').trim();
    return { idToken, name: name || undefined };
  }

  if (!(await appleAvailable())) throw new Error('تسجيل الدخول بـ Apple مش متاح على الجهاز ده.');
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (error) {
    // The person closed the sheet: that is not an error worth a red banner.
    if ((error as { code?: string }).code === 'ERR_REQUEST_CANCELED') throw cancelled();
    throw error;
  }
  if (!credential.identityToken) throw new Error('Apple مرجّعش رمز دخول صالح. جرّب تاني.');
  // Apple sends the name exactly once, on the very first authorization; forward it then.
  const name = [credential.fullName?.givenName, credential.fullName?.familyName]
    .map(part => (part || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return { idToken: credential.identityToken, name: name || undefined };
}
