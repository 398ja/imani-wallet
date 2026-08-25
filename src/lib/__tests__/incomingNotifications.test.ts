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

const { startIncomingNotifications, stopIncomingNotifications } = await import(
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
})
