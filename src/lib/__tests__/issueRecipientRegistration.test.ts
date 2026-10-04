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

const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = []

/** When true, the gateway predates #168 and the registration answers 404. */
let registrationMissing = false
/** When true, the registration throws, as a dropped connection does. */
let registrationThrows = false
/** When true, the coupon never finishes minting within the poll budget. */
let neverMinted = false

vi.mock('../nip98', () => ({
  signedFetch: async (path: string, method: string, body?: Record<string, unknown>) => {
    calls.push({ path, method, body })

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

  // When polling runs out, the merchant is told the gateway will finish and send the coupon,
  // not that it was lost, so they do not sell it a second time.
  it('tells the merchant the gateway will finish a coupon that outlives the poll', async () => {
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
})
