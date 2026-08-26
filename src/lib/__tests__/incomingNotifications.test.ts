import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The three staging bugs in the incoming-payment toast, as tests.
 *
 * 1. the toast came back for a payment that had already settled,
 * 2. it came back after every page refresh,
 * 3. a real receipt produced no toast at all.
 *
 * (3) is `arrivalToast`/dmPoll and is covered in arrivalToast.test.ts; this file
 * is the drain loop: terminal-state skipping, persistent de-duplication, and the
 * ack that stops the server redelivering.
 */

// The module reads localStorage synchronously on a hot path, and the test env is
// node. A Map-backed stand-in is enough and keeps the assertions about behaviour
// rather than about jsdom.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

const toasts: { message: unknown; options?: unknown }[] = []
vi.mock('sonner', () => ({
  toast: {
    success: (message: unknown, options?: unknown) => {
      toasts.push({ message, options })
      return 'id'
    },
  },
}))

// The toast body renders a React component; the drain loop only needs it to be
// constructible, and asserting on the element would test React, not this.
vi.mock('../../components/ui/IncomingPaymentToast', () => ({
  IncomingPaymentToast: () => null,
  ReceivedPaymentToast: () => null,
}))

const signedFetch = vi.fn()
vi.mock('../nip98', () => ({ signedFetch: (...args: unknown[]) => signedFetch(...args) }))

const { startIncomingNotifications, stopIncomingNotifications, formatEnvelopeTotal } = await import(
  '../incomingNotifications'
)
const { computeNotificationId } = await import('../incomingNotification')

const SENDER = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const RECIPIENT = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
const SENDER_NPUB = 'npub10000000000000000000000000000000000000000000000000000000'
const RECIPIENT_NPUB = 'npub1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'

function envelope(overrides: Record<string, unknown> = {}) {
  const deliveryEventId = (overrides.deliveryEventId as string) ?? 'evt-1'
  const now = new Date().toISOString()
  return {
    v: 1,
    kind: 'incoming_payment_notification',
    notificationId: computeNotificationId({
      recipientPubkeyHex: RECIPIENT,
      senderPubkeyHex: SENDER,
      correlationId: deliveryEventId,
      currencyUnit: 'XAF',
    }),
    state: 'pending',
    sender: { pubkeyHex: SENDER, npub: SENDER_NPUB },
    recipient: { pubkeyHex: RECIPIENT, npub: RECIPIENT_NPUB },
    currency: { unit: 'XAF', decimals: 0 },
    total: { minorUnits: 4, display: '4 XAF' },
    parts: [{ partId: 'p1', amount: { minorUnits: 4, display: '4 XAF' }, state: 'pending' }],
    correlation: { deliveryEventId },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

/** One drain returning `envelopes`, then empty. Records ack bodies. */
function respondWith(envelopes: unknown[]) {
  const acked: string[][] = []
  signedFetch.mockImplementation(async (path: string, _method: string, body: unknown) => {
    if (path.endsWith('/ack')) {
      acked.push((body as { notificationIds: string[] }).notificationIds)
      return { ok: true, json: async () => ({ acknowledged: 1 }) }
    }
    return { ok: true, json: async () => ({ envelopes, moreAvailable: false }) }
  })
  return acked
}

/** The boot tick is fired from start() and is not awaited; let it settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  stopIncomingNotifications()
  store.clear()
  toasts.length = 0
  signedFetch.mockReset()
})

describe('the drain loop', () => {
  it('announces a pending payment once', async () => {
    respondWith([envelope()])
    startIncomingNotifications(RECIPIENT)
    await settle()

    expect(toasts).toHaveLength(1)
  })

  it('acks what it has shown, so the server stops redelivering it', async () => {
    const acked = respondWith([envelope()])
    startIncomingNotifications(RECIPIENT)
    await settle()

    expect(acked).toHaveLength(1)
    expect(acked[0]).toEqual([envelope().notificationId])
  })

  /**
   * Bug 1 as reported: "I keep getting the toast message, although the amount
   * has already settled." A redeemed envelope is a closed question.
   */
  it('never announces a payment that already settled', async () => {
    const acked = respondWith([envelope({ state: 'redeemed' })])
    startIncomingNotifications(RECIPIENT)
    await settle()

    expect(toasts).toHaveLength(0)
    // Still acked: silence alone would leave it on the queue forever.
    expect(acked[0]).toEqual([envelope().notificationId])
  })

  it.each(['failed_terminal', 'expired'])('stays quiet for a %s payment', async (state) => {
    respondWith([envelope({ state })])
    startIncomingNotifications(RECIPIENT)
    await settle()

    expect(toasts).toHaveLength(0)
  })

  /**
   * Bug 2 as reported: the toast returned after a refresh. A reload empties
   * every in-memory Set, so the de-duplication has to be persistent — this test
   * is the reason `seen` is in localStorage and not a module-level Set.
   */
  it('does not announce the same payment again after a reload', async () => {
    respondWith([envelope()])
    startIncomingNotifications(RECIPIENT)
    await settle()
    expect(toasts).toHaveLength(1)

    // A reload: module state is gone, storage is not. `stop()` clears the
    // in-memory session state exactly as unmounting would.
    stopIncomingNotifications()
    toasts.length = 0

    respondWith([envelope()])
    startIncomingNotifications(RECIPIENT)
    await settle()

    expect(toasts).toHaveLength(0)
  })

  it('keeps the seen record per account', async () => {
    respondWith([envelope()])
    startIncomingNotifications(RECIPIENT)
    await settle()

    const keys = [...store.keys()]
    expect(keys).toContain(`imani-wallet:incoming-seen:${RECIPIENT}`)
  })

  it('refuses an envelope addressed to somebody else, and does not ack it', async () => {
    const acked = respondWith([envelope()])
    // Same envelope, different wallet: step 4 of the validator rejects it.
    startIncomingNotifications(
      '1111111111111111111111111111111111111111111111111111111111111111',
    )
    await settle()

    expect(toasts).toHaveLength(0)
    // Deliberately NOT acked — consuming something that failed validation would
    // destroy the evidence of a backend bug.
    expect(acked).toHaveLength(0)
  })

  it('survives a failing ack without losing the toast', async () => {
    signedFetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/ack')) throw new Error('gateway down')
      return { ok: true, json: async () => ({ envelopes: [envelope()], moreAvailable: false }) }
    })
    startIncomingNotifications(RECIPIENT)
    await settle()

    expect(toasts).toHaveLength(1)
  })

  it('survives a localStorage that refuses to write', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    })
    respondWith([envelope()])
    startIncomingNotifications(RECIPIENT)
    await settle()

    // Degrades to announcing, which is the right way to fail: the user still
    // learns about their money.
    expect(toasts).toHaveLength(1)

    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
  })

  // The combination, which is the one that actually resurrects the reported
  // bug and which neither test above covers. The spec reviewer named it: the
  // toast fix rests on the ack AND on localStorage, and if BOTH fail the
  // server keeps redelivering an envelope nothing client-side remembers, so
  // the user is told about the same settled payment on every 10s tick.
  //
  // The in-memory mirror inside createPersistentBoundedSet is what stops it.
  it('announces once per session even when the ack fails AND localStorage is denied', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError: storage is disabled')
      },
      setItem: () => {
        throw new Error('SecurityError: storage is disabled')
      },
      removeItem: () => {},
    })
    // Ack never succeeds, so the server redelivers the same envelope forever.
    const env = envelope()
    signedFetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/ack')) throw new Error('gateway down')
      return { ok: true, json: async () => ({ envelopes: [env], moreAvailable: false }) }
    })

    // A DOM whose visibility events we can fire, to drive extra drain ticks
    // inside ONE session (a restart would legitimately reset the mirror).
    const listeners: Record<string, Array<() => void>> = {}
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: (t: string, fn: () => void) => {
        ;(listeners[t] ??= []).push(fn)
      },
      removeEventListener: (t: string, fn: () => void) => {
        listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn)
      },
    })

    startIncomingNotifications(RECIPIENT)
    await settle()
    expect(toasts).toHaveLength(1)

    // Three more drain ticks redelivering the very same notificationId.
    for (let i = 0; i < 3; i++) {
      for (const fn of listeners['visibilitychange'] ?? []) fn()
      await settle()
    }

    expect(
      toasts,
      'a settled payment must be announced once per session even with no ack and no storage',
    ).toHaveLength(1)

    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
  })
})

/**
 * The gateway pre-formats `total.display` with the decimals it stamped on the
 * send, which is 2 for every currency. Observed on staging against a genuine
 * FCFA 2 payment (notificationId 69046b1b…): the envelope carried
 * `display: "0.02 XAF"` for `minorUnits: 2`.
 *
 * Same defect the settlement toast had, on the other toast.
 */
describe('the amount the advance-notice toast announces', () => {
  const base = {
    currency: { unit: 'XAF', decimals: 0 },
    total: { minorUnits: 2, display: '0.02 XAF' },
  } as unknown as Parameters<typeof formatEnvelopeTotal>[0]

  it('ignores the server string for a zero-decimal currency', () => {
    const shown = formatEnvelopeTotal(base)
    expect(shown).not.toContain('0.02')
    expect(shown).toMatch(/\b2\b/)
  })

  it('keeps the decimals a two-decimal currency really has', () => {
    const eur = {
      currency: { unit: 'EUR', decimals: 2 },
      total: { minorUnits: 250, display: '2.50 EUR' },
    } as unknown as Parameters<typeof formatEnvelopeTotal>[0]

    expect(formatEnvelopeTotal(eur)).toContain('2.50')
  })

  it("uses the envelope's own decimals for a unit Intl cannot place", () => {
    // A merchant's own unit: we have no better answer than theirs, so the
    // envelope's currency.decimals is the fallback.
    //
    // Asserted on the WHOLE string, not toContain('7'). Using the issuance
    // resolver here (fallback 2) renders "0.07 BEANS" — a hundredfold error —
    // and both `toContain('7')` and `not.toContain('7.00')` pass for that, so
    // the obvious assertions could not detect the bug they guard. Mutation
    // testing found this; the loose version was already in the file.
    const beans = {
      currency: { unit: 'BEANS', decimals: 0 },
      total: { minorUnits: 7, display: '7 BEANS' },
    } as unknown as Parameters<typeof formatEnvelopeTotal>[0]

    const shown = formatEnvelopeTotal(beans)
    expect(shown).toBe('7 BEANS')
  })

  it('falls back to the server string when there is no unit at all', () => {
    const none = {
      currency: undefined,
      total: { minorUnits: 5, display: 'whatever the server said' },
    } as unknown as Parameters<typeof formatEnvelopeTotal>[0]

    expect(formatEnvelopeTotal(none)).toBe('whatever the server said')
  })
})

/**
 * A background tab should not keep signing NIP-98 requests.
 *
 * Every tick is a signature, a round trip and a gateway request thread, and a
 * hidden tab has nowhere to show the toast: sonner renders into a document
 * nobody is looking at. Staging logs showed one forgotten client draining 119
 * times in 20 minutes. Nothing is lost by pausing — the envelope stays queued
 * until acked, and focus triggers an immediate catch-up.
 */
describe('a hidden tab', () => {
  let visibility = 'visible'
  const listeners: Record<string, (() => void)[]> = {}

  beforeEach(() => {
    visibility = 'visible'
    for (const k of Object.keys(listeners)) delete listeners[k]
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibility
      },
      addEventListener: (t: string, fn: () => void) => {
        ;(listeners[t] ??= []).push(fn)
      },
      removeEventListener: (t: string, fn: () => void) => {
        listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn)
      },
    })
  })

  it('stops draining while hidden, and catches up when looked at again', async () => {
    // Fake timers BEFORE start(), so the interval start() creates is the one
    // under this test's control. Installing them afterwards leaves the real
    // interval running and advanceTimersByTime moves a clock nothing is on —
    // which makes the assertion pass whether or not the guard exists.
    vi.useFakeTimers()
    respondWith([])
    startIncomingNotifications(RECIPIENT)
    await vi.advanceTimersByTimeAsync(0)

    const afterBoot = signedFetch.mock.calls.length
    expect(afterBoot).toBeGreaterThan(0)

    visibility = 'hidden'
    await vi.advanceTimersByTimeAsync(60_000) // six intervals with nobody watching
    expect(signedFetch.mock.calls.length).toBe(afterBoot)

    // Back on screen: an immediate tick rather than waiting out the interval.
    visibility = 'visible'
    for (const fn of listeners['visibilitychange'] ?? []) fn()
    await vi.advanceTimersByTimeAsync(0)
    expect(signedFetch.mock.calls.length).toBeGreaterThan(afterBoot)

    vi.useRealTimers()
  })

  it('detaches the listener on stop', () => {
    startIncomingNotifications(RECIPIENT)
    expect((listeners['visibilitychange'] ?? []).length).toBe(1)

    // A listener outliving the loop would drain on the next focus after logout,
    // signing for an account that is no longer the user's.
    stopIncomingNotifications()
    expect((listeners['visibilitychange'] ?? []).length).toBe(0)
  })
})
