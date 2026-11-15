import type { OutboxItem, OutboxKind } from './types';

export interface Outbox {
  add(kind: OutboxKind, payload: unknown): Promise<void>;
  list(limit?: number): Promise<OutboxItem[]>;
  remove(key: string): Promise<void>;
  bump(key: string): Promise<void>;
  count(): Promise<number>;
  /** Drops everything queued on the device (used when an account is erased). */
  clear(): Promise<void>;
}
/**
 * Metro resolves `./queue` to `queue.native.ts` (expo-sqlite) on iOS/Android and to
 * `queue.web.ts` (localStorage) on web. This module only exists so TypeScript and
 * non-Metro tooling see the shared contract; it is never bundled by Metro.
 */
export function createQueue(): Promise<Outbox> {
  throw new Error('The platform outbox is selected by Metro (queue.native.ts / queue.web.ts).');
}
