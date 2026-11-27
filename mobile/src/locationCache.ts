import type { TrustedFix } from './locationIntegrity';

interface CachedFix { fix: TrustedFix; at: number }

/** Native last-known fixes obey the same freshness window as our in-memory cache. */
export function lastKnownMaxAge(maxAgeMs: number): number | null {
  return Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : null;
}
let cached: CachedFix | null = null;

/** Return the last precise fix while it is still inside the caller's freshness window. */
export function getCachedFix(maxAgeMs: number, now = Date.now()): TrustedFix | null {
  if (!cached || now - cached.at >= maxAgeMs) return null;
  return cached.fix;
}

export function cacheFix(fix: TrustedFix, at = Date.now()): void {
  cached = { fix, at };
}

export function clearLocationCache(): void {
  cached = null;
}

/** A system-reported simulated position makes any earlier cached coordinate unsafe to reuse. */
export function discardCachedFixForMockLocation(): void {
  clearLocationCache();
}
