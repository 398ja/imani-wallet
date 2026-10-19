import { drainDmPoll, startDmPoll, stopDmPoll } from './dmPoll'
import { startRosterSync, stopRosterSync } from './terminalRosterSyncNet'
import { startIncomingNotifications, stopIncomingNotifications } from './incomingNotifications'
import {
  closeReceives,
  closeSpends,
  drainReceives,
  drainSpends,
  drainTokenRedemptions,
  openReceives,
  openSpends,
} from './receiveGate'

/**
 * Logout across tabs (#335).
 *
 * Every tab of this wallet shares one browser store, but each runs its own
 * poller, its own receives and its own sends. A logout in one tab must not wipe
 * while another is half way through a receive or a send. So:
 *
 * 1. The logging-out tab takes the exclusive Web Lock `LOCK_NAME` (if the API is
 *    there). A second logout already holding it means this one is refused.
 * 2. It asks every other tab, over a BroadcastChannel, who is there ("ping").
 * 3. It asks each of them to PAUSE: close the receive and send gates, stop the
 *    writers, wait (bounded) for whatever is running, then answer "paused".
 * 4. Any tab that answers "busy", or answers ping but not pause in time, refuses
 *    the logout. The others are told to RESUME. Nothing is erased.
 * 5. Just before the wipe it asks again: a tab that was not paused refuses it.
 * 6. After the wipe it says DONE, and the paused tabs reload.
 *
 * A paused tab that never hears RESUME or DONE (the logging-out tab was closed)
 * waits for the logout lock to be released, or `ORPHAN_PAUSE_MS` where there is
 * no Locks API, then resumes if the key is still here and reloads if not.
 *
 * Where BroadcastChannel is missing, other tabs cannot be reached at all, so
 * the logout is refused: "cannot coordinate" is a block, never a wave-through.
 */

export const CHANNEL_NAME = 'imani-wallet:logout'
export const LOCK_NAME = 'imani-wallet:logout'
/** How long logout waits for other tabs to say they are there. */
export const PING_WINDOW_MS = 400
/** How long logout waits for a paused tab to finish what it was doing. */
export const PAUSE_TIMEOUT_MS = 20_000
/** How long a paused tab drains before it answers "busy". Under PAUSE_TIMEOUT_MS. */
export const TAB_DRAIN_MS = 15_000
/** A paused tab with no Locks API and no word back resumes (or reloads) after this. */
export const ORPHAN_PAUSE_MS = 120_000

type Message =
  | { t: 'ping'; run: string; from: string }
  | { t: 'pong'; run: string; from: string; paused: boolean }
  | { t: 'pause'; run: string; from: string }
  | { t: 'paused'; run: string; from: string; ok: boolean }
  | { t: 'resume'; run: string; from: string }
  | { t: 'done'; run: string; from: string }

interface ChannelLike {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}

interface LocksLike {
  request(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<unknown> | unknown,
  ): Promise<unknown>
}

function newChannel(): ChannelLike | null {
  try {
    const BC = (globalThis as { BroadcastChannel?: new (name: string) => ChannelLike }).BroadcastChannel
    return BC ? new BC(CHANNEL_NAME) : null
  } catch {
    return null
  }
}

function locks(): LocksLike | null {
  const l = (globalThis as { navigator?: { locks?: LocksLike } }).navigator?.locks
  return l && typeof l.request === 'function' ? l : null
}

/** A fresh id per logout and per listener, so each ignores only its own posts. */
function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random()}`
  }
}

/** The other tabs, paused for this logout. */
export interface PausedTabs {
  /** Asks again, just before the wipe: true only when every tab that answers was paused. */
  stillPaused(): Promise<boolean>
  /** Logout refused: the paused tabs carry on, and the lock is released. */
  resume(): void
  /** Logout done: the paused tabs reload, and the lock is released. */
  done(): void
}

export type PauseResult = { ok: true; tabs: PausedTabs } | { ok: false }

export interface PauseOptions {
  pingWindowMs?: number
  pauseTimeoutMs?: number
  channel?: () => ChannelLike | null
  locks?: () => LocksLike | null
}

/** Collect "pong"s for one ping, for `windowMs`. */
function ping(
  channel: ChannelLike,
  tabId: string,
  run: string,
  windowMs: number,
  listen: (fn: (m: Message) => void) => () => void,
): Promise<Map<string, boolean>> {
  const seen = new Map<string, boolean>()
  return new Promise((resolve) => {
    const stop = listen((m) => {
      if (m.t === 'pong' && m.run === run) seen.set(m.from, m.paused === true)
    })
    channel.postMessage({ t: 'ping', run, from: tabId } satisfies Message)
    setTimeout(() => {
      stop()
      resolve(seen)
    }, windowMs)
  })
}

/**
 * Take the logout lock and pause every other tab. `{ ok: false }` means the
 * logout must be refused: another logout holds the lock, a tab is busy or did
 * not answer, or other tabs cannot be reached at all. Never throws.
 */
export async function pauseOtherTabs(options: PauseOptions = {}): Promise<PauseResult> {
  const { pingWindowMs = PING_WINDOW_MS, pauseTimeoutMs = PAUSE_TIMEOUT_MS } = options
  const channel = (options.channel ?? newChannel)()
  if (!channel) return { ok: false }
  const tabId = newId()

  // The lock is held by a promise this function resolves on resume/done.
  let releaseLock: () => void = () => {}
  const lockApi = (options.locks ?? locks)()
  if (lockApi) {
    const granted = await new Promise<boolean>((resolve) => {
      lockApi
        .request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false)
            return undefined
          }
          resolve(true)
          return new Promise<void>((done) => (releaseLock = done))
        })
        .catch(() => resolve(false))
    })
    if (!granted) {
      channel.close()
      return { ok: false }
    }
  }

  const listeners = new Set<(m: Message) => void>()
  channel.onmessage = (event) => {
    const m = event.data as Message
    if (!m || typeof m !== 'object' || m.from === tabId) return
    for (const fn of [...listeners]) fn(m)
  }
  const listen = (fn: (m: Message) => void) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }
  const run = `${tabId}:${Date.now()}`
  let closed = false
  const finish = (t: 'resume' | 'done') => {
    if (closed) return
    closed = true
    try {
      channel.postMessage({ t, run, from: tabId } satisfies Message)
    } catch {
      // Nothing to tell: a paused tab falls back to the lock or its own timer.
    }
    channel.close()
    releaseLock()
  }

  try {
    const others = await ping(channel, tabId, run, pingWindowMs, listen)
    const paused = new Set<string>()
    if (others.size > 0) {
      const allPaused = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          stop()
          resolve(false)
        }, pauseTimeoutMs)
        const stop = listen((m) => {
          if (m.t !== 'paused' || m.run !== run) return
          if (!m.ok) {
            clearTimeout(timer)
            stop()
            resolve(false)
            return
          }
          paused.add(m.from)
          if ([...others.keys()].every((o) => paused.has(o))) {
            clearTimeout(timer)
            stop()
            resolve(true)
          }
        })
        channel.postMessage({ t: 'pause', run, from: tabId } satisfies Message)
      })
      if (!allPaused) {
        finish('resume')
        return { ok: false }
      }
    }
    return {
      ok: true,
      tabs: {
        stillPaused: async () => {
          if (closed) return false
          try {
            const now = await ping(channel, tabId, run, pingWindowMs, listen)
            // Every tab that answers must be one this logout paused, and still paused.
            return [...now].every(([o, isPaused]) => isPaused && paused.has(o))
          } catch {
            return false
          }
        },
        resume: () => finish('resume'),
        done: () => finish('done'),
      },
    }
  } catch {
    finish('resume')
    return { ok: false }
  }
}

export interface ListenDeps {
  /** Stop this tab's writers and close its gates. */
  pause?: () => void
  /** Wait for what this tab has running. Whether it drained. */
  drain?: (timeoutMs: number) => Promise<boolean>
  /** Re-open the gates and restart the writers. */
  resume?: () => void
  /** The other tab wiped the wallet: throw this document away. */
  reload?: () => void
  /** Whether the key is still on the device, for an orphaned pause. */
  keyStillHere?: () => Promise<boolean>
  channel?: () => ChannelLike | null
  locks?: () => LocksLike | null
  orphanMs?: number
  drainMs?: number
}

function defaultPause(): void {
  closeReceives()
  closeSpends()
  stopDmPoll()
  stopRosterSync()
  stopIncomingNotifications()
}

async function defaultDrain(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const left = () => Math.max(0, deadline - Date.now())
  return (
    (await drainDmPoll(left()).catch(() => false)) &&
    (await drainReceives(left())) &&
    (await drainTokenRedemptions(left())) &&
    (await drainSpends(left()))
  )
}

/**
 * Answer other tabs' logouts, for the life of this tab's session. Returns the
 * stop function. Never throws.
 */
export function listenForLogout(pubkey: string, deps: ListenDeps = {}): () => void {
  const channel = (deps.channel ?? newChannel)()
  if (!channel) return () => {}
  const tabId = newId()
  const pause = deps.pause ?? defaultPause
  const drain = deps.drain ?? defaultDrain
  const resume =
    deps.resume ??
    (() => {
      openReceives()
      openSpends()
      for (const start of [startDmPoll, startRosterSync, startIncomingNotifications]) {
        try {
          start(pubkey)
        } catch {
          // One writer failing to start must not keep the others, or the gates, closed.
        }
      }
    })
  const reload = deps.reload ?? (() => window.location.replace('/'))
  const keyStillHere =
    deps.keyStillHere ?? (async () => (await import('./nap')).hasStoredKey().catch(() => false))
  const lockApi = (deps.locks ?? locks)()
  const orphanMs = deps.orphanMs ?? ORPHAN_PAUSE_MS
  const drainMs = deps.drainMs ?? TAB_DRAIN_MS

  let pausedFor: string | null = null
  let orphanTimer: ReturnType<typeof setTimeout> | undefined

  const safely = (fn: () => void) => {
    try {
      fn()
    } catch {
      // Best effort: the gates were reopened first.
    }
  }
  const doResume = () => {
    pausedFor = null
    clearTimeout(orphanTimer)
    safely(() => {
      openReceives()
      openSpends()
    })
    safely(resume)
  }
  const settleOrphan = async (run: string) => {
    if (pausedFor !== run) return
    if (await keyStillHere()) doResume()
    else reload()
  }

  channel.onmessage = (event) => {
    const m = event.data as Message
    if (!m || typeof m !== 'object' || m.from === tabId) return
    const reply = (msg: Message) => {
      try {
        channel.postMessage(msg)
      } catch {
        // The logout times out on a tab that cannot answer, and refuses.
      }
    }
    if (m.t === 'ping') {
      reply({ t: 'pong', run: m.run, from: tabId, paused: pausedFor === m.run })
    } else if (m.t === 'pause') {
      pausedFor = m.run
      safely(pause)
      void drain(drainMs)
        .catch(() => false)
        .then((ok) => {
          if (pausedFor !== m.run) return
          reply({ t: 'paused', run: m.run, from: tabId, ok })
          if (!ok) {
            doResume()
            return
          }
          // The logging-out tab may vanish without a word.
          if (lockApi) {
            void lockApi
              .request(LOCK_NAME, { mode: 'shared' }, () => undefined)
              .then(() => settleOrphan(m.run), () => settleOrphan(m.run))
          } else {
            orphanTimer = setTimeout(() => void settleOrphan(m.run), orphanMs)
          }
        })
    } else if (m.t === 'resume' && pausedFor === m.run) {
      doResume()
    } else if (m.t === 'done' && pausedFor === m.run) {
      pausedFor = null
      clearTimeout(orphanTimer)
      reload()
    }
  }
  return () => {
    channel.onmessage = null
    channel.close()
    // Stopped while paused (the session lapsed and the authed tree unmounted,
    // say): nothing can hear RESUME or DONE any more, so the orphan fallback is
    // the only way out. Cancelling its timer here, as this did, left the gates
    // closed and the writers stopped for the rest of the page's life, even
    // after the tab was unlocked again (review of #335). It is kept, and still
    // resumes only once the wait is over: resuming sooner would restart a tab
    // the logout can no longer ask about.
    if (pausedFor === null) clearTimeout(orphanTimer)
  }
}
