/**
 * Push notifications through the Expo push service.
 *
 * The phone registers an Expo push token (which wraps either FCM or APNs), and the server posts
 * one JSON array to Expo, which fans it out. That choice is deliberate: the installation needs
 * **no** FCM service account and **no** APNs key on the VPS. The project's FCM/APNs credentials
 * are configured with EAS for Expo's delivery service, so the self-hosted server never handles
 * a private push key.
 *
 * Three rules this module keeps:
 *   - it never throws into a request. A notification that fails must not turn a saved report into
 *     a failed one;
 *   - it never sends a token that is obviously not an Expo token (a stray string in the database
 *     is not a reason to call a third party);
 *   - a token the service reports as `DeviceNotRegistered` is handed back so the caller can delete
 *     it — an uninstalled app is the normal case, and a stale row would be retried for ever.
 */

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Anything the app may want to act on when the notification is tapped (a route, an id). */
  data?: Record<string, unknown>;
}

export interface PushResult {
  /** Messages the service accepted. */
  delivered: number;
  /** Tokens the service says no longer exist; the caller should delete them. */
  invalid: string[];
  /** Messages that were not accepted for any other reason (network, 5xx, rate limit). */
  failed: number;
}

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH = 100;
const TOKEN = /^Expo(nent)?PushToken\[[^\]\s]{8,}\]$/;
const TIMEOUT_MS = 8000;

export function isPushToken(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && TOKEN.test(value);
}

/**
 * A seam for the tests. It replaces the network call, not the batching, the token filter or the
 * error handling — those are what the tests are for.
 */
type Transport = (body: string, signal: AbortSignal) => Promise<{ status: number; json: unknown }>;
let transport: Transport | null = null;
export function setPushTransport(next: Transport | null) { transport = next; }

async function post(body: string, signal: AbortSignal) {
  if (transport) return transport(body, signal);
  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
    signal,
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

export async function sendPush(messages: PushMessage[]): Promise<PushResult> {
  const result: PushResult = { delivered: 0, invalid: [], failed: 0 };
  const usable = messages.filter(message => isPushToken(message.to));
  result.failed += messages.length - usable.length;
  for (let start = 0; start < usable.length; start += BATCH) {
    const chunk = usable.slice(start, start + BATCH);
    // Expo expects one message object; a single-element array is also accepted by the API, but
    // the documented shape for a batch is an array of messages — both are handled by sending an
    // array only when there is more than one.
    const payload = JSON.stringify(chunk.map(message => ({
      to: message.to,
      title: message.title,
      body: message.body,
      data: message.data ?? {},
      sound: 'default',
      priority: 'high',
      channelId: 'default',
    })));
    try {
      const { status, json } = await post(payload, AbortSignal.timeout(TIMEOUT_MS));
      if (status < 200 || status >= 300) { result.failed += chunk.length; continue; }
      // Accepted responses carry `{ data: [ {status:'ok'} | {status:'error', details:{error}} ] }`.
      const tickets = (json as { data?: Array<{ status?: string; details?: { error?: string } }> } | null)?.data;
      if (!Array.isArray(tickets) || tickets.length !== chunk.length) {
        // An answer we cannot read is not a success; keep the tokens and try again next time.
        result.failed += chunk.length;
        continue;
      }
      tickets.forEach((ticket, index) => {
        if (ticket?.status === 'ok') { result.delivered += 1; return; }
        if (ticket?.details?.error === 'DeviceNotRegistered') { result.invalid.push(chunk[index].to); return; }
        result.failed += 1;
      });
    } catch {
      // Offline, DNS, timeout: the notification is lost, the request is not.
      result.failed += chunk.length;
    }
  }
  return result;
}
