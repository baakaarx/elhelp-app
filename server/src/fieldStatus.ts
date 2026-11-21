import { haversine } from './geo.js';

/**
 * Telling "the engineer stopped working" apart from "the phone stopped talking".
 *
 * The manager's screen used to have one word for both — انقطاع في إرسال الموقع — and that word
 * handed everyone an excuse: a phone that died, an app the OS froze, and a Sunday nap all looked
 * identical, while the engineer could always say "النت كان واقع". The two facts that separate them
 * are already in the database, they were just never compared:
 *
 * - `users.last_seen` moves on ANY authenticated request from the phone (the shift poll, the fix
 *   batch, presence). A fresh stamp with no fixes means the network was fine and the *position*
 *   is what is missing — permission, GPS blocked, or a frozen app.
 * - `locations.battery` rides with every fix, so a phone about to die announces itself minutes
 *   before the silence, and a silence that starts at 6٪ reads as what it is.
 *
 * Both functions are pure so the rule can be tested without a server.
 */

/** Three missed 15-second polls, plus slack for a slow field connection. */
export const PRESENT_FRESH_MS = 150_000;
/** The phone reports its battery with every fix; warn before the shift dies with it. */
export const LOW_BATTERY_PERCENT = 10;
/** Fixes inside this radius of the newest one count as the same spot, not as movement. */
export const STATIONARY_RADIUS_M = 60;

export type SilenceKind = 'ok' | 'gps_blocked' | 'gone';

export interface SilenceInput {
  /** `now - MAX(locations.recorded_at)` for this engineer. */
  silenceMs: number;
  /** The window he is allowed to be quiet in (a visit in progress widens it). */
  limitMs: number;
  /** `now - users.last_seen`; `Infinity` when this phone never reached the server. */
  presenceMs: number;
}

/**
 * Classify a silent phone. Order matters: the network verdict is checked first, because a phone
 * that can reach the API cannot blame the coverage.
 */
export function classifySilence({ silenceMs, limitMs, presenceMs }: SilenceInput): SilenceKind {
  if (!(silenceMs > limitMs)) return 'ok';
  return presenceMs <= PRESENT_FRESH_MS ? 'gps_blocked' : 'gone';
}

/**
 * How long the newest fixes have all sat in one place. Standing still is not a fault and must not
 * be reported as one — but the manager is entitled to see it, which is what makes «قعد واقف لحد
 * الصبح» provable instead of a matter of opinion.
 *
 * Takes the day's points in chronological order.
 */
export function stationaryMinutes(points: Array<{ lat: number; lng: number; recordedAt: number }>, now = Date.now()): number {
  if (!points.length) return 0;
  const anchor = points[points.length - 1];
  let index = points.length - 2;
  while (index >= 0 && haversine(points[index], anchor) <= STATIONARY_RADIUS_M) index--;
  const since = Number(index >= 0 ? points[index + 1].recordedAt : points[0].recordedAt);
  return Math.max(0, Math.round((now - since) / 60_000));
}
