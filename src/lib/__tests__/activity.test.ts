/**
 * @vitest-environment jsdom
 *
 * Whether somebody is actually there.
 *
 * This is a security boundary, not a convenience. The session re-auth hook asks
 * the gateway to confirm a suspected lapse, and asking SLIDES the server's idle
 * window — so whatever this module reports "active" for gets its session
 * renewed. If a timer or a background fetch could satisfy it, an untouched
 * phone would keep its wallet unlocked all night.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { watchActivity } from '../activity'

describe('watchActivity', () => {
  let stop: (() => void) | null = null

  afterEach(() => {
    stop?.()
    stop = null
  })

  const start = () => {
    const watcher = watchActivity(window)
    stop = watcher.stop
    return watcher
  }

  it('reports nothing when nobody has touched anything', () => {
    const { consumeActivity } = start()

    expect(consumeActivity()).toBe(false)
  })

  it.each(['pointerdown', 'keydown', 'scroll', 'touchstart', 'pointermove', 'wheel'])(
    'counts %s as a person being present',
    (event) => {
      const { consumeActivity } = start()

      window.dispatchEvent(new Event(event))

      expect(consumeActivity()).toBe(true)
    },
  )

  it('does not count an event the app raised itself', () => {
    // The whole point. A poller, a sync tick, or a notification arriving must
    // never be able to renew a session on an absent user's behalf.
    const { consumeActivity } = start()

    window.dispatchEvent(new Event('imani:poll'))
    window.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))

    expect(consumeActivity()).toBe(false)
  })

  it('spends the signal on read, so one tap cannot renew twice', () => {
    // A flag that stayed true would let a single ancient tap slide the window
    // on every subsequent check — the renewal loop, arriving by another door.
    const { consumeActivity } = start()

    window.dispatchEvent(new Event('pointerdown'))

    expect(consumeActivity()).toBe(true)
    expect(consumeActivity()).toBe(false)
  })

  it('collapses a burst into one answer rather than counting it', () => {
    const { consumeActivity } = start()

    for (let i = 0; i < 100; i += 1) window.dispatchEvent(new Event('pointermove'))

    expect(consumeActivity()).toBe(true)
    expect(consumeActivity()).toBe(false)
  })

  it('goes deaf once stopped, so an unmounted screen cannot vouch for anyone', () => {
    const { consumeActivity, stop: halt } = start()
    halt()
    stop = null

    window.dispatchEvent(new Event('pointerdown'))

    expect(consumeActivity()).toBe(false)
  })

  it('hears input even when a handler stops propagation', () => {
    // Registered in the capture phase: a screen that swallows its own events
    // must not make the user invisible to the session.
    const { consumeActivity } = start()
    const swallow = (e: Event) => e.stopPropagation()
    document.addEventListener('pointerdown', swallow)

    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))

    expect(consumeActivity()).toBe(true)
    document.removeEventListener('pointerdown', swallow)
  })
})
