/**
 * Which failures are worth retrying later.
 *
 * The two report screens only queued an offline report (`status === 0`). Everything else — a
 * 502 while the manager restarted the service, a 503, a 429 rate limit — threw the engineer's
 * typed report away and he had to write it again in the field.
 *
 * A 4xx is different: the request itself is wrong (validation, a duplicate id, a dead session),
 * so retrying it forever would only fill the queue. Those are shown to the engineer instead.
 */
export function shouldQueue(error: unknown): boolean {
  const status = (error as { status?: number } | null | undefined)?.status ?? 0;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}
