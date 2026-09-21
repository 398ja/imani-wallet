/**
 * Writing a growing set to `localStorage` without freezing the page.
 *
 * `localStorage.setItem` is SYNCHRONOUS and serialises the whole value. Two
 * stores in the receive path re-write their entire contents every time one
 * entry is added — the processed-event ids in `dmPoll.ts` and the completed
 * transfers in `dmChunks.ts` — which is O(n) per add and O(n²) over a catch-up.
 *
 * That was tolerable only because both sets were small. Sizing them to the
 * poller's 7-day fetch window, which is what stops a large sale churning
 * forever, made it not: measured at a 5000-entry cap, a 2000-event catch-up
 * serialises ~134MB in ~1800 synchronous writes, the largest of them ~335KB,
 * every one of them on the main thread and between the user and a rendered
 * frame. The cap is correct and the write strategy was not.
 *
 * So the write is deferred and coalesced: many adds in one burst produce one
 * write. The data is a CACHE — losing the tail of it costs a re-read of wraps
 * the wallet already handled, and `hasTokenBeenReceived` (keyed on the token
 * fingerprint) is what actually prevents double-crediting — so trading exact
 * durability for a responsive page is the right way round. It is still flushed
 * when the page is hidden, which on mobile is the last moment anything runs.
 */

/** A pending deferred write, keyed by storage key so two stores cannot collide. */
const scheduled = new Map<string, () => void>()

/**
 * The live timer per key, if any.
 *
 * Separate from `scheduled` because a key can have a timer with nothing queued
 * (after a cancel) and must not then acquire a second timer. Keeping the handle
 * also lets `cancelDeferredWrite` clear the timer rather than leave it to fire
 * into an empty queue.
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

let flushBound = false

/**
 * Run one queued write, swallowing anything it throws.
 *
 * Every caller already wraps its own `setItem`, but this must not DEPEND on
 * that. An exception escaping here goes to an unhandled rejection from a timer
 * callback with no caller to catch it, and — worse — the entry has already been
 * removed from `scheduled`, so the failure would be silent and the write simply
 * lost. Storage throwing is the expected case, not the exotic one: quota is
 * reachable with the set sizes this exists to support, and private browsing
 * throws on access.
 */
function runWrite(write: () => void): void {
  try {
    write()
  } catch (error) {
    console.warn('[deferredWrite] a deferred write failed; continuing', error)
  }
}

/**
 * Flush every outstanding write NOW, synchronously.
 *
 * Bound to `pagehide` and to `visibilitychange`, not to `beforeunload`: a
 * wallet on a phone is killed rather than closed, and `beforeunload` is the one
 * event that reliably does not fire there. `visibilitychange` to hidden is the
 * last guaranteed callback, and this app is a PWA on exactly that platform.
 *
 * Drains a COPY, and clears before running: a write that somehow re-queues
 * during a flush must not extend the loop it is running inside.
 */
export function flushDeferredWrites(): void {
  const writes = [...scheduled.values()]
  scheduled.clear()
  // The timers have nothing left to do, and leaving them pending would keep a
  // key looking "covered" so the next deferWrite never started a fresh one.
  for (const [, handle] of timers) clearTimeout(handle)
  timers.clear()
  for (const write of writes) runWrite(write)
}

function bindFlush(): void {
  if (flushBound || typeof document === 'undefined') return
  flushBound = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDeferredWrites()
  })
  window.addEventListener('pagehide', flushDeferredWrites)
}

/**
 * Queue `write`, replacing any write already queued for `key`.
 *
 * Coalescing is the whole point: a catch-up that processes 2000 events queues
 * 2000 times and writes once. The callback must read its own current state
 * when it runs rather than capturing a snapshot, or it will persist a value
 * that was already stale when it was queued.
 *
 * `setTimeout(0)` rather than a microtask, deliberately. A microtask runs at
 * the end of the current task, which during an `await`-driven loop is after
 * every single iteration — that is the behaviour being fixed, not a fix for
 * it. A macrotask yields to rendering first and lands once the burst is over.
 */
export function deferWrite(key: string, write: () => void): void {
  bindFlush()

  // Replace the queued callback so the newest state wins.
  scheduled.set(key, write)

  // A live timer for this key already covers it. Tracked SEPARATELY from
  // `scheduled` rather than inferred from it, because the two can disagree.
  //
  // `cancelDeferredWrite` empties the queue while its timer is still pending,
  // so inferring "nothing queued" to mean "no timer" made the next
  // `deferWrite` start a second one for the same key. Measured: one cancel
  // plus one requeue left TWO pending timers where one was needed. The extra
  // one fires into an empty queue and does no damage, but it is a timer per
  // cancel that nothing clears — and sign-out and the amnesty both cancel, so
  // it accumulates on exactly the paths that repeat.
  //
  // Holding the handle also lets a cancel clear its own timer instead of
  // leaving it to fire for nothing.
  if (timers.has(key)) return

  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      const pending = scheduled.get(key)
      if (!pending) return // Cancelled, or already flushed by a page-hide.
      scheduled.delete(key)
      runWrite(pending)
    }, 0),
  )
}

/**
 * Drop the queued write for one key without running it.
 *
 * For a caller that is about to make the queued write WRONG rather than
 * redundant — clearing a store on sign-out is the case that matters, where
 * letting a stale queued write land afterwards would put the cleared data
 * back on disk.
 */
export function cancelDeferredWrite(key: string): void {
  scheduled.delete(key)
  const handle = timers.get(key)
  if (handle !== undefined) {
    clearTimeout(handle)
    timers.delete(key)
  }
}

/** Drop every queued write without running any. For tests. */
export function cancelDeferredWrites(): void {
  scheduled.clear()
  for (const [, handle] of timers) clearTimeout(handle)
  timers.clear()
}
