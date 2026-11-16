import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';

/**
 * Verification of the ID tokens Google and Apple hand back after a sign-in.
 *
 * The phone never talks to Google/Apple on the server's behalf: it obtains a signed JWT from
 * the provider's own SDK and sends it here. This module checks the signature against the
 * provider's published keys and every claim that matters (`iss`, `aud`, `exp`, verified email),
 * using only Node's crypto — no JWT library, no extra dependency to audit.
 */

export type OauthProvider = 'google' | 'apple';

export interface OauthIdentity {
  provider: OauthProvider;
  /** Stable per-provider user id (`sub`). This is what accounts are linked on. */
  subject: string;
  /** Lower-cased email, or '' when the provider did not return one (Apple only sends it once). */
  email: string;
}

export class OauthError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 401, code = 'OAUTH_INVALID_TOKEN') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ENDPOINTS: Record<OauthProvider, { keys: string; issuers: string[] }> = {
  google: {
    keys: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['accounts.google.com', 'https://accounts.google.com'],
  },
  apple: {
    keys: 'https://appleid.apple.com/auth/keys',
    issuers: ['https://appleid.apple.com'],
  },
};

/** Clock skew tolerated on `exp`/`iat`, in seconds — phone clocks drift. */
const SKEW_SECONDS = 120;
/** Provider keys are rotated rarely; refetching on every sign-in would make login depend on Google. */
const KEY_CACHE_MS = 15 * 60 * 1000;

type Jwk = Record<string, unknown> & { kid?: string; kty?: string };
type KeySource = (provider: OauthProvider) => Promise<Jwk[]>;

const cache = new Map<OauthProvider, { at: number; keys: Jwk[] }>();

async function fetchKeys(provider: OauthProvider): Promise<Jwk[]> {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < KEY_CACHE_MS) return hit.keys;
  let res: Response;
  try {
    res = await fetch(ENDPOINTS[provider].keys, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new OauthError('تعذر الوصول لمزوّد تسجيل الدخول. جرّب تاني.', 503, 'OAUTH_UNAVAILABLE');
  }
  if (!res.ok) throw new OauthError('تعذر الوصول لمزوّد تسجيل الدخول. جرّب تاني.', 503, 'OAUTH_UNAVAILABLE');
  const body = (await res.json().catch(() => null)) as { keys?: Jwk[] } | null;
  const keys = Array.isArray(body?.keys) ? body!.keys : [];
  if (!keys.length) throw new OauthError('مزوّد تسجيل الدخول رجّع مفاتيح غير صالحة.', 503, 'OAUTH_UNAVAILABLE');
  cache.set(provider, { at: Date.now(), keys });
  return keys;
}

/**
 * Tests replace the key source with a keypair of their own, so verification is exercised
 * end to end without a network call to Google.
 */
let keySource: KeySource = fetchKeys;
export function setKeySource(source: KeySource | null): void {
  keySource = source ?? fetchKeys;
  cache.clear();
}

function decodeSegment(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new OauthError('الرمز المرسل غير صالح.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new OauthError('الرمز المرسل غير صالح.');
  return parsed as Record<string, unknown>;
}

async function publicKeyFor(provider: OauthProvider, kid: string | undefined) {
  const usable = (kid: string | undefined, keys: Jwk[]) =>
    keys.find(key => key.kty === 'RSA' && (!kid || key.kid === kid));

  let keys = await keySource(provider);
  let jwk = usable(kid, keys);
  if (!jwk) {
    // The provider rotated its keys between two sign-ins: drop the cache and ask once more.
    cache.delete(provider);
    keys = await keySource(provider);
    jwk = usable(kid, keys);
  }
  if (!jwk) throw new OauthError('مفتاح التوقيع غير معروف. جرّب تسجيل الدخول تاني.');
  try {
    return createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
  } catch {
    throw new OauthError('مفتاح التوقيع غير صالح.', 503, 'OAUTH_UNAVAILABLE');
  }
}

/**
 * Verifies a provider ID token and returns who it belongs to.
 *
 * `audiences` is every client id the installation accepts (an iOS client, an Android client and
 * a web client each produce a token with a different `aud`).
 */
export async function verifyIdToken(
  provider: OauthProvider,
  token: string,
  options: { audiences: string[]; now?: number },
): Promise<OauthIdentity> {
  if (typeof token !== 'string' || token.length < 40 || token.length > 8192) {
    throw new OauthError('الرمز المرسل غير صالح.');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new OauthError('الرمز المرسل غير صالح.');
  const header = decodeSegment(parts[0]);
  // RS256 only: accepting "none" or a shared secret here would let anyone mint an identity.
  if (header.alg !== 'RS256') throw new OauthError('نوع توقيع الرمز غير مدعوم.');
  const payload = decodeSegment(parts[1]);
  const key = await publicKeyFor(provider, typeof header.kid === 'string' ? header.kid : undefined);
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  if (!verifySignature('RSA-SHA256', signed, key, signature)) {
    throw new OauthError('توقيع الرمز غير صحيح.');
  }

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const issuer = String(payload.iss ?? '');
  if (!ENDPOINTS[provider].issuers.includes(issuer)) throw new OauthError('الرمز صادر من جهة غير معروفة.');

  const audience = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud ?? '')];
  if (!audience.some(value => options.audiences.includes(value))) {
    throw new OauthError('الرمز مش صادر للتطبيق ده.');
  }

  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp + SKEW_SECONDS < now) throw new OauthError('انتهت صلاحية الرمز. جرّب تاني.');
  const issued = Number(payload.iat);
  if (Number.isFinite(issued) && issued - SKEW_SECONDS > now) throw new OauthError('الرمز بتاريخ مستقبلي.');

  const subject = String(payload.sub ?? '');
  if (!subject || subject.length > 255) throw new OauthError('الرمز من غير معرّف مستخدم.');

  // Google always sends `email_verified`; Apple sends a verified address or nothing at all.
  const email = String(payload.email ?? '').trim().toLowerCase();
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (email && provider === 'google' && !verified) {
    throw new OauthError('البريد الإلكتروني غير مؤكد عند جوجل.');
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new OauthError('الرمز يحتوي بريدًا غير صالح.');

  return { provider, subject, email };
}
