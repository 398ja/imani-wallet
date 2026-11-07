/**
 * Run `fn` under a Web Lock named `name`, exclusive across every tab of this
 * origin, or just run it where the Locks API is missing (tests, older
 * browsers, some embedded WebViews).
 *
 * Every tab runs its own DM poller and its own receipt timer over the SAME
 * local storage, so a read, an await and a write back is a race between tabs
 * even when each tab is sequential on its own. This is the one place that
 * closes it. Without the API the caller still gets its in-tab behaviour, which
 * is what it had before, and callers keep their own claim-before-await
 * discipline so a missing lock degrades to a narrow window rather than a
 * silent double action.
 */
export async function withWebLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks
  if (!locks || typeof locks.request !== 'function') return fn()
  return locks.request(name, fn) as Promise<T>
}

/** The slice of `LockManager` used here, so tests can supply a fake. */
interface LockManagerLike {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>
}

const queues = new Map<string, Promise<unknown>>()

/**
 * `withWebLock`, plus an in-tab queue on the same name: calls in this tab run one after another
 * even where the Locks API is missing. Not re-entrant: nothing run under it may take it again.
 * Shared by checkout codes (#402) and Cashlinks made on the direct path (#543).
 */
export function withQueuedLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(name) ?? Promise.resolve()
  const run = prior.catch(() => undefined).then(() => withWebLock(name, fn))
  const tail = run.catch(() => undefined)
  queues.set(name, tail)
  void tail.then(() => {
    if (queues.get(name) === tail) queues.delete(name)
  })
  return run
}
