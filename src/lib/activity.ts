/**
 * Whether the person is still there.
 *
 * The re-auth prompt asks the gateway to confirm a suspected lapse, and that
 * question is not free of consequences: `/auth/validate` SLIDES the idle window
 * as a side effect of being asked. Asking it on a timer therefore keeps the
 * session alive forever — the wallet would renew its own session on behalf of a
 * phone lying face-down on a café table, which is precisely the situation the
 * idle timeout exists for.
 *
 * So the client has to answer, locally and honestly, the question the server
 * cannot answer for it: has a HUMAN done anything since we last asked? Only
 * then is a slide legitimate, because only then does the server's own rule —
 * "an authenticated request means the user is active" — actually hold.
 *
 * This module is the record of that. It is deliberately tiny and deliberately
 * separate from anything that talks to the network, so the decision to renew a
 * session can never be made by code that is merely polling.
 */

/**
 * Events that count as a person being present.
 *
 * Real input only, and nothing a timer or a background fetch can raise. A
 * poller that could mark the user active would reintroduce the bug this module
 * exists to prevent, one layer down.
 *
 * `scroll` and `pointermove` are included because reading a long list of
 * transactions is genuine use; they are also the noisiest, which is why the
 * reader below only ever asks "was there any?" rather than counting them.
 */
const ACTIVITY_EVENTS = [
  'pointerdown',
  'keydown',
  'scroll',
  'touchstart',
  'pointermove',
  'wheel',
] as const

/**
 * Watch for signs of life.
 *
 * Returns a reader that answers whether anything has happened SINCE THE LAST
 * TIME IT WAS READ, and a stop function. The read is destructive on purpose:
 * the caller uses it to decide "may I renew the session once", and an answer
 * that stayed true would renew on every subsequent tick from one ancient tap.
 *
 * No state is exported and nothing is persisted. Presence is a property of this
 * tab in this moment, and a value surviving a reload would be a claim that
 * somebody was at the device when the page was not even open.
 */
export function watchActivity(target: EventTarget = window): {
  /** True if a person has interacted since this was last called. Resets on read. */
  consumeActivity: () => boolean
  stop: () => void
} {
  let seen = false
  const note = () => {
    seen = true
  }

  for (const event of ACTIVITY_EVENTS) {
    // Capture phase so activity is observed even when a handler stops
    // propagation, and passive so noting it can never delay a scroll.
    target.addEventListener(event, note, { capture: true, passive: true })
  }

  return {
    consumeActivity: () => {
      const was = seen
      seen = false
      return was
    },
    stop: () => {
      for (const event of ACTIVITY_EVENTS) {
        target.removeEventListener(event, note, { capture: true })
      }
    },
  }
}
