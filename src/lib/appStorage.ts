/**
 * Remove every `imani-wallet:*` localStorage entry. Shared by logout and by taking a terminal
 * off a device (#160 round 2), so the two cannot drift as the list of keys grows.
 *
 * @param keep keys to leave in place (logout keeps the settled-but-unsaved record, #112)
 * @returns the keys removed
 */
export function sweepAppStorage(keep?: (key: string) => boolean): string[] {
  const removed: string[] = []
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('imani-wallet:') && !keep?.(key)) {
      localStorage.removeItem(key)
      removed.push(key)
    }
  }
  return removed
}
