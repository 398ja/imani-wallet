/**
 * A small per-account list in localStorage, bounded, newest kept (#94).
 *
 * Three copies of this grew in one change: the recipient's bundle arrivals,
 * the advance notices per bundle, and the sender's claims per bundle. Each
 * needed the same four properties, and getting any one wrong per copy is how
 * one surface leaks or forgets where the others do not:
 *
 *   - PER ACCOUNT, under `imani-wallet:<name>:<pubkey>`, so two people on one
 *     device never see each other's payments, and logout's `imani-wallet:*`
 *     sweep removes it without being told about it;
 *   - BOUNDED, keeping the most recent `limit` items, because an unbounded
 *     list in localStorage eventually throws on the write after it fills;
 *   - FILTERED on read, since what is stored survived a reload, may have been
 *     written by an older build, and is editable by hand;
 *   - NEVER THROWING. It holds display state only. A denied or full
 *     localStorage costs the grouping across reloads, never money, and must
 *     not surface as an error on the paths that call it.
 *
 * Deliberately synchronous: every caller reads it on a notification path that
 * is itself synchronous, the same reasoning the inbox gives for localStorage.
 */
export interface AccountStore<T> {
  /** Every item for the account, newest first. */
  list(pubkey: string): T[]
  get(pubkey: string, id: string): T | undefined
  /** Insert or replace by id, then trim to the limit. */
  put(pubkey: string, item: T): void
  /** Drop one item by id. Returns whether there was one to drop. */
  remove(pubkey: string, id: string): boolean
}

export function createAccountStore<T>(opts: {
  /** The key segment: `imani-wallet:<name>:<pubkey>`. */
  name: string
  limit: number
  idOf: (item: T) => string
  /** Epoch ms used to decide what is newest. */
  ageOf: (item: T) => number
  isValid: (value: unknown) => value is T
}): AccountStore<T> {
  const key = (pubkey: string) => `imani-wallet:${opts.name}:${pubkey}`

  function list(pubkey: string): T[] {
    try {
      const raw = localStorage.getItem(key(pubkey))
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter(opts.isValid) : []
    } catch {
      return []
    }
  }

  function put(pubkey: string, item: T): void {
    const id = opts.idOf(item)
    const next = [item, ...list(pubkey).filter((existing) => opts.idOf(existing) !== id)]
      .sort((a, b) => opts.ageOf(b) - opts.ageOf(a))
      .slice(0, opts.limit)
    try {
      localStorage.setItem(key(pubkey), JSON.stringify(next))
    } catch (e) {
      console.warn(`[${opts.name}] could not persist:`, e)
    }
  }

  return {
    list,
    get: (pubkey, id) => list(pubkey).find((item) => opts.idOf(item) === id),
    put,
    remove(pubkey, id) {
      const current = list(pubkey)
      const next = current.filter((item) => opts.idOf(item) !== id)
      if (next.length === current.length) return false
      try {
        localStorage.setItem(key(pubkey), JSON.stringify(next))
      } catch (e) {
        console.warn(`[${opts.name}] could not persist:`, e)
      }
      return true
    },
  }
}
