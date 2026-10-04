/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * imani-gateway-customer#168: a sale the gateway finishes only after a crash.
 *
 * The gateway can finish a quote-backed coupon minutes after this screen has
 * stopped polling for it, and then nothing used to carry the token to the
 * customer. The Sell flow now tells the gateway who the coupon is for BEFORE it
 * polls, so the gateway can send it on by itself. These tests pin that the
 * registration happens, happens first, names the customer, and can never fail
 * the sale.
 */

const calls: Array<{
  path: string
  method: string
  body?: Record<string, unknown>
  signal?: AbortSignal
}> = []

/** When true, the gateway predates #168 and the registration answers 404. */
let registrationMissing = false
/** When true, the registration throws, as a dropped connection does. */
let registrationThrows = false
/** When true, the coupon never finishes minting within the poll budget. */
let neverMinted = false
/** When true, the registration never answers until its signal aborts, as a stalled connection does. */
let registrationHangs = false

vi.mock('../nip98', () => ({
  signedFetch: async (
    path: string,
    method: string,
    body?: Record<string, unknown>,
    _signer?: unknown,
    options: { signal?: AbortSignal } = {},
  ) => {
    calls.push({ path, method, body, signal: options.signal })

    if (path === '/api/v1/portal/vouchers') {
      // Quote-backed: no token yet, so the flow must poll.
      return {
        ok: true,
        json: async () => ({
          items: [{ voucher_id: 'v168', status: 'ISSUED', face_value_minor: 700, currency: 'EUR' }],
        }),
        text: async () => '',
      }
    }

    if (path === '/api/v1/wallet/vouchers/v168/recipient') {
      if (registrationThrows) throw new Error('network down')
      if (registrationHangs) {
        // Never answers by itself; only an abort ends it, as fetch rejects on abort.
        return new Promise((_, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation timed out.', 'TimeoutError')),
          )
        })
      }
      return registrationMissing
        ? { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' }
        : { ok: true, status: 204, json: async () => ({}), text: async () => '' }
    }

    if (path === '/api/v1/wallet/vouchers/v168') {
      return {
        ok: true,
        json: async () =>
          neverMinted
            ? { voucher_id: 'v168', status: 'PENDING', payment_state: 'PAID' }
            : {
                voucher_id: 'v168',
                status: 'ISSUED',
                token: 'cashu-v168',
                face_value: 700,
                face_unit: 'EUR',
                expires_at: 1_900_000_000,
              },
        text: async () => '',
      }
    }

    if (path === '/api/v1/dm/tokens/send') {
      return { ok: true, json: async () => ({ event_id: 'evt-v168' }), text: async () => '' }
    }

    return { ok: true, json: async () => ({}), text: async () => '' }
  },
}))

vi.mock('../wallet', () => ({
  getWallet: () => ({ addTransaction: async () => {} }),
  notifyWalletChanged: () => {},
}))

vi.mock('../relay', () => ({ INTERNAL_RELAY_URL: 'ws://relay.test' }))

/** An unlocked wallet holding the stall's key, so the owner's sale is warranted (#159). */
vi.mock('../nap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nap')>()),
  getSigner: () => ({
    pubkey: 'a'.repeat(64),
    withPrivkey: <T,>(borrow: (key: Uint8Array) => T): T => borrow(new Uint8Array(32).fill(7)),
  }),
}))

const { issueAndDeliver } = await import('../issue')
const { ownerActor } = await import('../actor')

const CUSTOMER = 'c'.repeat(64)

const params = {
  faceValueMinor: 700,
  currency: 'EUR',
  expiryDays: 30,
  recipientPubkey: CUSTOMER,
  actor: ownerActor('a'.repeat(64))!,
}

const registrations = () => calls.filter((c) => c.path.endsWith('/recipient'))

beforeEach(() => {
  calls.length = 0
  registrationMissing = false
  registrationThrows = false
  neverMinted = false
  registrationHangs = false
  vi.restoreAllMocks()
})

describe('registering the customer of a quote-backed sale (gateway-customer#168)', () => {
  // The gateway is told who the coupon is for, with a PUT naming the customer's key.
  it('registers the customer for the coupon', async () => {
    await issueAndDeliver(params)

    expect(registrations()).toEqual([
      {
        path: '/api/v1/wallet/vouchers/v168/recipient',
        method: 'PUT',
        body: { recipient_pubkey: CUSTOMER },
        signal: expect.any(AbortSignal),
      },
    ])
  })

  // It happens before the first poll, so a crash during polling still leaves the gateway knowing
  // where to send the coupon.
  it('registers before it polls', async () => {
    await issueAndDeliver(params)

    const registered = calls.findIndex((c) => c.path.endsWith('/recipient'))
    const firstPoll = calls.findIndex((c) => c.path === '/api/v1/wallet/vouchers/v168')
    expect(registered).toBeGreaterThanOrEqual(0)
    expect(registered).toBeLessThan(firstPoll)
  })

  // A gateway that predates the endpoint answers 404; the sale goes on and is delivered as before.
  it('still delivers when the gateway does not know the endpoint', async () => {
    registrationMissing = true

    const result = await issueAndDeliver(params)

    expect(result.vouchers).toHaveLength(1)
    expect(calls.filter((c) => c.path === '/api/v1/dm/tokens/send')).toHaveLength(1)
  })

  // A registration that throws never fails the sale either.
  it('still delivers when the registration throws', async () => {
    registrationThrows = true

    const result = await issueAndDeliver(params)

    expect(result.vouchers).toHaveLength(1)
  })

  // MEDIUM-2: when the gateway accepted the registration and polling runs out, the merchant is told
  // the gateway will finish and send the coupon, not that it was lost, so they do not sell it again.
  it('tells the merchant the gateway will send it when the registration was accepted', async () => {
    neverMinted = true
    vi.useFakeTimers()
    try {
      const run = issueAndDeliver(params)
      const assertion = expect(run).rejects.toThrow(/sends it to the customer by itself/)
      await vi.runAllTimersAsync()
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  // MEDIUM-2: when the registration failed (here a 404 from an older gateway), the gateway does
  // not know the customer, so the merchant must not be promised a delivery that will not happen.
  // They are told to check before selling again and to forward it themselves.
  it('does not promise the gateway will send it when the registration failed', async () => {
    neverMinted = true
    registrationMissing = true
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const run = issueAndDeliver(params)
      const assertion = expect(run).rejects.toThrow(
        /could not be told who the customer is.*forward it to the customer yourself/,
      )
      await vi.runAllTimersAsync()
      await assertion
      await expect(run).rejects.not.toThrow(/sends it to the customer by itself/)
    } finally {
      vi.useRealTimers()
    }
  })

  // MEDIUM-2: a failed registration is logged as a warning naming the voucher only by a prefix and
  // the HTTP status, with no customer key and no token in it.
  it('warns, without secrets, when the registration fails', async () => {
    registrationMissing = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await issueAndDeliver(params)

    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls[0])
    expect(logged).toContain('404')
    expect(logged).not.toContain(CUSTOMER)
    expect(logged).not.toContain('cashu-v168')
  })

  // MEDIUM-3: the registration carries a deadline, so a gateway that never answers it cannot hold
  // the sale. After 5 s it is abandoned and the coupon is still polled and delivered.
  it('gives up on a registration that hangs and still delivers', async () => {
    registrationHangs = true
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const run = issueAndDeliver(params)
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.runAllTimersAsync()
      const result = await run

      expect(result.vouchers).toHaveLength(1)
      expect(calls.filter((c) => c.path === '/api/v1/dm/tokens/send')).toHaveLength(1)
      expect(registrations()[0].signal).toBeInstanceOf(AbortSignal)
    } finally {
      vi.useRealTimers()
    }
  })
})
