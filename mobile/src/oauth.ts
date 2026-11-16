import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as AppleAuthentication from 'expo-apple-authentication';

/**
 * The two social sign-ins, done with the providers' own SDKs.
 *
 * The app never sees a client secret: Google and Apple hand it a signed ID token and the
 * company server (server/src/oauth.ts) decides whether that token is real and whether the
 * person behind it has an account. Both buttons stay hidden unless the server says the
 * provider is configured *and* the platform can complete the flow.
 */

const GOOGLE = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
};

/**
 * One Google client per platform, all three registered in the same Google Cloud project.
 * A token minted for the iOS client has a different `aud` from the Android one, so the
 * server is given the whole list (GOOGLE_CLIENT_IDS).
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
export const googleConfigured = Platform.OS !== 'web' && googleClientId().length > 0;

/** The native Apple sheet only exists on iOS 13+, and only when the entitlement is signed in. */
export async function appleAvailable(): Promise<boolean> {
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

export async function signInWithGoogle(): Promise<{ idToken: string }> {
  if (!googleConfigured) throw new Error('تسجيل الدخول بـ Google غير مهيّأ في النسخة دي.');
  const request = new AuthSession.AuthRequest({
    clientId: googleClientId(),
    responseType: AuthSession.ResponseType.IdToken,
    scopes: ['openid', 'profile', 'email'],
    // Must be registered in the Google Cloud console as an authorized redirect URI.
    redirectUri: AuthSession.makeRedirectUri({ scheme: 'elhelbmandoob', path: 'oauth' }),
    extraParams: { prompt: 'select_account' },
  });
  const result = await request.promptAsync(GOOGLE, { showInRecents: true });
  if (result.type !== 'success') throw cancelled();
  const idToken = result.params.id_token;
  if (!idToken) throw new Error('جوجل مرجّعش رمز دخول صالح. جرّب تاني.');
  return { idToken };
}

export async function signInWithApple(): Promise<{ idToken: string; name?: string }> {
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
