/** A weak fix must not be presented as a fresh reading at the previous coordinates.
 * The API accepts positive accuracy up to the shared limit, or unknown accuracy. */
export function queueableAccuracy(accuracy: number | null | undefined, limit: number): boolean {
  return accuracy == null || (Number.isFinite(accuracy) && accuracy > 0 && accuracy <= limit);
}
