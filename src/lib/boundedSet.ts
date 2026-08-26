/**
 * Bounded "have I already handled this?" sets.
 *
 * Three copies of this idea had grown independently: `announced` in
 * `arrivalToast.ts` (in-memory, oldest-first eviction), `seen` in
 * `incomingNotifications.ts` (localStorage, per-account, tail-trimmed) and
 * `rejectedThisSession` (in-memory, unbounded — the one that could actually
 * grow forever). The code review flagged the duplication; collapsing them also
 * fixes the unbounded one for free.
 *
 * Every one of these guards the same user-visible property: a payment must be
 * announced ONCE. Getting eviction subtly different per copy means one screen
 * re-announces a payment the other has correctly suppressed, so the policy
 * belongs in one place.
 *
 * Bounded because the alternative is a leak in a tab that stays open for days.
 * The cap sits far above any real backlog, and the oldest entries fall off
 * first: re-announcing a payment from a thousand notifications ago is the
 * acceptable worst case for a store that must not grow without limit.
 */

/**
 * A bounded set of ids.
 *
 * `size` is deliberately NOT on this interface. The in-memory implementation
 * would answer "ids I hold", the persistent one "ids I have seen THIS session"
 * — up to `limit` more sit in storage — so one interface would be answering two
 * different questions depending on which object you happened to have. Nothing
 * in production needs it, so the honest move is not to offer it. The in-memory
 * implementation exposes `size` on its own concrete type for tests.
 */
export interface BoundedSet {
  has(id: string): boolean
  /** Records the id. Returns true if it was NEW (i.e. the caller should act). */
  add(id: string): boolean
  clear(): void
}

/**
 * In-memory bounded set with oldest-first eviction.
 *
 * Relies on `Set` iterating in insertion order, which is specified behaviour,
 * so `values().next()` is the oldest entry.
 */
export function createBoundedSet(limit: number): BoundedSet & { readonly size: number } {
  const ids = new Set<string>()
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (ids.has(id)) return false
      ids.add(id)
      if (ids.size > limit) {
        const oldest = ids.values().next().value
        if (oldest !== undefined) ids.delete(oldest)
      }
      return true
    },
    get size() {
      return ids.size
    },
    clear: () => ids.clear(),
  }
}

/**
 * Bounded set persisted to localStorage under a per-account key, with an
 * in-memory mirror that keeps working when storage does not.
 *
 * The mirror is the point. Private-browsing modes, a full quota and enterprise
 * policies all make `localStorage` throw, and the previous code caught that,
 * logged it, and carried on with NO de-duplication at all for the session. That
 * combination — the ack failing AND storage denied — is exactly what resurrects
 * the "toast repeats after settlement" bug the user reported, because the
 * server redelivers an un-acked envelope and nothing client-side remembers it.
 * Degrading to in-memory keeps the toast correct for the session; only a reload
 * can then repeat it.
 */
export function createPersistentBoundedSet(
  storageKey: string,
  limit: number,
  onWarn?: (message: string, error: unknown) => void,
): BoundedSet {
  // Always consulted, and the only record when storage is unavailable.
  const memory = new Set<string>()

  function load(): string[] {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
      // Unreadable or unparseable is the same as empty; the memory mirror still
      // holds this session's ids.
      return []
    }
  }

  return {
    has(id) {
      return memory.has(id) || load().includes(id)
    },
    add(id) {
      if (memory.has(id)) return false
      const stored = load()
      const known = stored.includes(id)
      memory.add(id)
      if (memory.size > limit) {
        const oldest = memory.values().next().value
        if (oldest !== undefined) memory.delete(oldest)
      }
      try {
        const next = stored.filter((v) => v !== id)
        next.push(id)
        localStorage.setItem(storageKey, JSON.stringify(next.slice(-limit)))
      } catch (e) {
        // Non-fatal: de-duplication degrades to the in-memory mirror for this
        // session rather than disappearing entirely. Reported through onWarn
        // rather than exposed as a `persisted` flag — a flag nothing reads is a
        // flag nobody maintains, and the first version was already wrong (never
        // reset by clear(), and a failing READ left it true).
        onWarn?.('could not persist the seen marker', e)
      }
      return !known
    },
    clear() {
      memory.clear()
      try {
        localStorage.removeItem(storageKey)
      } catch {
        // Nothing to do; the mirror is already cleared.
      }
    },
  }
}
