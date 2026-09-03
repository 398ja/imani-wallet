/**
 * An expiring, bounded map.
 *
 * The primitive under replay protection, idempotency and throttling. All three
 * are the same shape: remember something per caller for a bounded time, in
 * bounded memory, on a service that must not leak.
 *
 * ## Why not `src/lib/boundedSet.ts`
 *
 * The repository already has a bounded set, and the ticket points at it. It is
 * the right tool for its job — "did I already toast this payment?" — and the
 * wrong one here, because it evicts by COUNT alone.
 *
 * Measured, not assumed: record one id in a set capped at 100, add 100 cheap
 * entries, and the first id is gone while its signature is still inside the
 * 60-second freshness window. An attacker floods, the victim's request is
 * forgotten, and the captured request replays successfully. Count-only
 * eviction turns replay protection into a race the attacker chooses when to
 * run.
 *
 * So entries here expire by TIME, and time is what makes forgetting safe: once
 * a signature is outside the freshness window, `verifyNip98` refuses it as
 * stale whether or not this store remembers it. Forgetting an expired entry
 * cannot admit a replay. Forgetting a live one can.
 *
 * ## What happens at capacity
 *
 * A hard cap is still needed, or a flood is a memory leak instead. But evicting
 * a LIVE entry to make room is exactly the hole above, so this refuses to do
 * it: at capacity with nothing expired, `set` reports `at-capacity` and the
 * caller decides. The service's answer is to fail closed and refuse the
 * request.
 *
 * That is a real trade and worth stating plainly. Fail-closed under flood is a
 * denial of service; fail-open is an accepted replay. On a service about to
 * move money, a caller retrying in a minute is strictly better than a spend
 * that happens twice — and ADR 0001 already accepts denial of service as this
 * design's failure mode.
 */

/** What happened when something was recorded. */
export type SetOutcome = 'new' | 'duplicate' | 'at-capacity'

export interface ExpiringMap<V> {
  /**
   * Record a value under a key, if the key is new and there is room.
   *
   * `duplicate` means the key is already held and still live — for replay
   * protection that IS the refusal.
   */
  set(key: string, value: V, now: number): SetOutcome
  /** The live value for a key, or undefined if absent or expired. */
  get(key: string, now: number): V | undefined
  /** Live entries held. Expired-but-unpurged entries are not counted. */
  size(now: number): number
  clear(): void
}

/**
 * @param ttlMs      how long an entry stays live
 * @param capacity   the most live entries held at once
 */
export function createExpiringMap<V>(ttlMs: number, capacity: number): ExpiringMap<V> {
  // Insertion-ordered, which `Map` guarantees. Since every entry shares one
  // TTL, insertion order IS expiry order, so purging can stop at the first
  // live entry instead of scanning the whole map.
  const entries = new Map<string, { value: V; expiresAt: number }>()

  function purge(now: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt > now) break
      entries.delete(key)
    }
  }

  return {
    set(key, value, now) {
      // Before the capacity check, so an expired entry never causes a refusal.
      // Doing this the other way round would fail closed on a service that is
      // merely holding stale rows.
      purge(now)

      // Anything still present has survived purge, so it is LIVE. There is no
      // expired-but-present case to handle: every entry shares one TTL, so
      // insertion order is expiry order and purge stops only at a live entry
      // with nothing expired behind it.
      //
      // Two earlier versions guarded this anyway — `existing.expiresAt > now`
      // here, and a delete-before-set to "keep the order right". A brute-force
      // reachability search over 20,000 random operation sequences reached
      // neither branch once, which is why they are gone: an unreachable branch
      // cannot be tested, and an untested branch that looks load-bearing is
      // worse than no branch at all.
      //
      // This is a property of the SHARED ttl. Per-entry expiry would break it,
      // and would need both guards back.
      if (entries.has(key)) return 'duplicate'

      if (entries.size >= capacity) return 'at-capacity'

      entries.set(key, { value, expiresAt: now + ttlMs })
      return 'new'
    },

    get(key, now) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= now) {
        entries.delete(key)
        return undefined
      }
      return entry.value
    },

    size(now) {
      purge(now)
      return entries.size
    },

    clear() {
      entries.clear()
    },
  }
}
