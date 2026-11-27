import type { RouteResponse } from './types';

type Fix = RouteResponse['points'][number];
export type DisplayFix = Fix & { breakBefore: boolean };
const MAX_GAP_MS = 10 * 60 * 1000;

function meters(a: Fix, b: Fix): number {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(Math.min(1, Math.max(0, h))), Math.sqrt(Math.max(0, 1 - h)));
}

/** Display only: never alter stored fixes or computed distances. A move within the combined
 * reported uncertainty is ambiguous, not proof of travel. Unknown accuracy remains visible.
 * Break lines across shifts, gaps or skipped weak fixes instead of inventing a route. */
export function displayRoute(points: Fix[], raw = false): DisplayFix[] {
  const result: DisplayFix[] = [];
  let previous: Fix | undefined, anchor: Fix | undefined, broken = true;
  for (const point of points) {
    if (previous && (point.shiftId !== previous.shiftId || point.recordedAt - previous.recordedAt > MAX_GAP_MS || point.recordedAt < previous.recordedAt)) {
      broken = true; anchor = undefined;
    }
    previous = point;
    if (!raw && point.accuracy != null && (point.accuracy <= 0 || point.accuracy > 100)) {
      broken = true; anchor = undefined; continue;
    }
    if (!raw && anchor && point.accuracy != null && anchor.accuracy != null &&
      meters(anchor, point) <= Math.max(10, anchor.accuracy + point.accuracy)) continue;
    result.push({ ...point, breakBefore: broken });
    anchor = point; broken = false;
  }
  return result;
}

export function routeSegments(points: DisplayFix[]): DisplayFix[][] {
  const segments: DisplayFix[][] = [];
  for (const point of points) {
    if (point.breakBefore || !segments.length) segments.push([]);
    segments[segments.length - 1].push(point);
  }
  return segments;
}
