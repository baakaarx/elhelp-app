/** Only two successful empty server responses can confirm a locally active shift was closed. */
export async function confirmShiftState<T>(
  initial: T | null,
  locallyActive: boolean,
  retry: () => Promise<{ shift: T | null }>,
  wait: () => Promise<void>,
): Promise<{ shift: T | null; closed: boolean }> {
  if (initial || !locallyActive) return { shift: initial, closed: false };
  await wait();
  // Let failures propagate: a missing response is not a confirmation of closure.
  const result = await retry();
  return { shift: result.shift, closed: result.shift === null };
}
