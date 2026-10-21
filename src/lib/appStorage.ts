/**
 * Remove every `imani-wallet:*` localStorage entry. Shared by logout and by taking a terminal
 * off a device (#160 round 2), so the two cannot drift as the list of keys grows.
 *
 * @returns the keys removed
 */
export function sweepAppStorage(): string[] {
  const removed: string[] = []
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('imani-wallet:')) {
      localStorage.removeItem(key)
      removed.push(key)
    }
  }
  return removed
}
