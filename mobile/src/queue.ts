import type { OutboxItem, OutboxKind } from './types';

export interface Outbox {
  add(kind: OutboxKind, payload: unknown): Promise<void>;
  list(limit?: number): Promise<OutboxItem[]>;
  /** All field actions in FIFO order, plus a bounded batch of GPS points. */
  listForReplay(locationLimit?: number, includeRejectedLocations?: boolean): Promise<OutboxItem[]>;
  countRejectedLocations(): Promise<number>;
  remove(key: string): Promise<void>;
  bump(key: string): Promise<void>;
  reject(key: string): Promise<void>;
  unreject(key: string): Promise<void>;
  count(kind?: OutboxKind): Promise<number>;
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
