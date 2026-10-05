/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * A split sale delivers EVERY part.
 *
 * The incident this file exists for: a 1000-unit sale was split by the gateway
 * into 5 coupons of 200 (`portal_voucher_auto_split parts=5`), and the wallet
 * read `items[0]` and delivered one of them. The customer received 200. The
 * other four were minted, left PENDING, never polled, and never delivered —
 * production logs showed `voucher_finalized` exactly once and a GET for only
 * the first voucher id.
 *
 * Every existing issuance test mocked a ONE-item response, so all of them
 * passed throughout. The bug was not a broken behaviour but an unasked
 * question, which is why these tests mock a MULTI-item response and assert on
 * counts rather than on the first element.
 */

const calls: string[] = []
const bodies: Array<Record<string, unknown>> = []
const transactions: Array<Record<string, unknown>> = []

/** The 5 x 200 split from the incident, as the portal returned it. */
const PARTS = ['v1', 'v2', 'v3', 'v4', 'v5']
const PART_VALUE = 20000

/** Voucher ids whose delivery should fail, for the partial-failure tests. */
const failDeliveryFor = new Set<string>()
/** Voucher ids that never finish minting. */
const stallMintFor = new Set<string>()
/** When true, the create response returns quote-backed parts with no token yet. */
let createPending = false
/** When true, GET /api/v1/wallet/vouchers/{id} answers 404 (gateway-customer#126). */
let pollNotFound = false
/**
 * Which spelling of the amount the mocked gateway offers.
 *
 * Both are real: the create response uses `face_value_minor`, the poll uses
 * `face_value`. `none` stands for a gateway that omits it altogether.
 */
let valueField: 'face_value' | 'face_value_minor' | 'none' = 'face_value'

/**
 * When false, the portal predates imani-gateway-portal#48 and its create items
 * have no `token` field at all, so every part must be polled.
 */
let portalReturnsToken = true
/** Parts the portal returns without a token (quote-backed), though their poll succeeds. */
const noTokenAtCreate = new Set<string>()

/**
 * One item of the portal's create response, in the exact shape of
 * `CreatePortalVouchersResponse.CreatedVoucherItem` (imani-gateway-api 0.12.0):
 * `voucher_id`, `status`, `face_value_minor`, `currency`, `expires_at` (an
 * ISO-8601 Instant), `claim_url` and `token`. No `face_unit`, no `face_value`.
 *
 * The portal reports `status: 'ISSUED'` for EVERY item, including quote-backed
 * ones that have no token yet (`toCreatedItem` hard-codes it). So `status` alone
 * never means "minted": only a present `token` does. `token` is omitted (the
 * portal's NON_NULL) for a quote-backed part, and entirely for an old portal.
 */
const createdItem = (id: string) => ({
  voucher_id: id,
  status: 'ISSUED',
  ...(valueField === 'none' ? {} : { face_value_minor: PART_VALUE }),
  currency: 'GBP',
  expires_at: '2030-03-17T17:46:40Z',
  claim_url: `https://app.example/voucher/${id}`,
  // A part that never finishes minting is, by construction, still unminted at create.
  ...(portalReturnsToken && !createPending && !stallMintFor.has(id) && !noTokenAtCreate.has(id)
    ? { token: `cashu-${id}` }
    : {}),
})

/** The amount fields a mocked voucher carries, per `valueField`. */
const valueOf = () =>
  valueField === 'none' ? {} : { [valueField]: PART_VALUE }

vi.mock('../nip98', () => ({
  signedFetch: async (path: string, _method?: string, body?: Record<string, unknown>) => {
    calls.push(path)
    if (body) bodies.push(body)

    // Issuance: hand back all five parts, the way the portal does after a split.
    if (path === '/api/v1/portal/vouchers') {
      return {
        ok: true,
        json: async () => ({ items: PARTS.map(createdItem) }),
        text: async () => '',
      }
    }

    // Polling one part.
    const polled = path.match(/\/api\/v1\/wallet\/vouchers\/(.+)$/)?.[1]
    if (polled) {
      if (pollNotFound) {
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' }
      }
      if (stallMintFor.has(polled)) {
        return { ok: true, json: async () => ({ voucher_id: polled, status: 'PENDING' }), text: async () => '' }
      }
      return {
        ok: true,
        json: async () => ({
          voucher_id: polled,
          status: 'ISSUED',
          token: `cashu-${polled}`,
          ...valueOf(),
          face_unit: 'GBP',
          expires_at: 1_900_000_000,
        }),
        text: async () => '',
      }
    }

    // Delivery.
    if (path === '/api/v1/dm/tokens/send') {
      const id = String(body?.voucher_id ?? '')
      if (failDeliveryFor.has(id)) {
        return { ok: false, status: 500, text: async () => 'relay unreachable' }
      }
      return { ok: true, json: async () => ({ event_id: `evt-${id}` }), text: async () => '' }
    }

    return { ok: true, json: async () => ({}), text: async () => '' }
  },
}))

vi.mock('../wallet', () => ({
  getWallet: () => ({
    addTransaction: async (row: Record<string, unknown>) => {
      transactions.push(row)
    },
  }),
  notifyWalletChanged: () => {},
}))

vi.mock('../relay', () => ({ INTERNAL_RELAY_URL: 'ws://relay.test' }))

/**
 * An unlocked wallet holding the STALL's key, so an owner's sale signs a
 * `merchant` warrant. Without one the warrant is absent, and since #159 Sell
 * refuses a sale every recipient would refuse (`assertSaleWarranted`).
 * The pubkey is the test's STALL; only `signer.pubkey === stall` is checked
 * before signing, and nothing here verifies the signature.
 */
vi.mock('../nap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nap')>()),
  getSigner: () => ({
    pubkey: 'a'.repeat(64),
    withPrivkey: <T,>(borrow: (key: Uint8Array) => T): T => borrow(new Uint8Array(32).fill(7)),
  }),
}))

const { issueAndDeliver } = await import('../issue')
const { ownerActor } = await import('../actor')

const STALL = 'a'.repeat(64)

const params = {
  // The whole sale: 5 parts x 200.00.
  faceValueMinor: PART_VALUE * PARTS.length,
  currency: 'GBP',
  expiryDays: 30,
  recipientPubkey: 'b'.repeat(64),
  actor: ownerActor(STALL)!,
}

const deliveries = () =>
  calls.filter((c) => c === '/api/v1/dm/tokens/send').length

beforeEach(() => {
  calls.length = 0
  bodies.length = 0
  transactions.length = 0
  failDeliveryFor.clear()
  stallMintFor.clear()
  valueField = 'face_value'
  createPending = false
  pollNotFound = false
  portalReturnsToken = true
  noTokenAtCreate.clear()
})

describe('a sale the gateway split into several coupons', () => {
  it('delivers every part, not just the first', async () => {
    const result = await issueAndDeliver(params)

    // The regression, stated directly: five coupons were issued, five must go.
    expect(deliveries()).toBe(PARTS.length)
    expect(result.vouchers).toHaveLength(PARTS.length)
  })

  it('polls every quote-backed (PENDING) part for its token', async () => {
    createPending = true

    await issueAndDeliver(params)

    for (const id of PARTS) {
      expect(calls).toContain(`/api/v1/wallet/vouchers/${id}`)
    }
    expect(deliveries()).toBe(PARTS.length)
  })

  /**
   * gateway-customer#126: a coupon issued from the float comes back from create
   * already ISSUED with its token. Re-reading it 404'd, so the sale failed after
   * the proofs were spent. The create response is enough.
   */
  it('uses the token from the create response without re-reading it', async () => {
    pollNotFound = true

    const result = await issueAndDeliver(params)

    expect(calls.some((c) => c.startsWith('/api/v1/wallet/vouchers/'))).toBe(false)
    expect(deliveries()).toBe(PARTS.length)
    expect(result.vouchers.map((v) => v.token)).toEqual(PARTS.map((id) => `cashu-${id}`))
  })

  /**
   * Rolling-deploy safety: until imani-gateway-portal#48 ships, the create
   * response has no `token` field. The wallet must fall back to polling, not
   * deliver an empty token.
   */
  it('still polls every part against an old portal that returns no token', async () => {
    portalReturnsToken = false

    const result = await issueAndDeliver(params)

    for (const id of PARTS) {
      expect(calls).toContain(`/api/v1/wallet/vouchers/${id}`)
    }
    expect(deliveries()).toBe(PARTS.length)
    expect(result.vouchers.map((v) => v.token)).toEqual(PARTS.map((id) => `cashu-${id}`))
  })

  it('delivers a create-response coupon with its face value and unit', async () => {
    valueField = 'face_value_minor'

    await issueAndDeliver(params)

    const sent = bodies.filter((b) => 'token' in b)
    expect(sent).toHaveLength(PARTS.length)
    for (const b of sent) {
      expect(b.face_value).toBe(PART_VALUE)
      expect(b.face_unit).toBe('GBP')
      expect(b.face_decimals).toBe(2)
      expect(b.expires_at).toBe(1_900_000_000)
    }
  })

  it('polls only the parts that came back without a token', async () => {
    // Mixed batch: v2 is quote-backed, the rest were issued from float.
    noTokenAtCreate.add('v2')

    const result = await issueAndDeliver(params)

    // Only the quote-backed part is registered for gateway delivery (gateway-customer#168) and
    // then polled; a part that came back minted is neither.
    expect(calls.filter((c) => c.startsWith('/api/v1/wallet/vouchers/'))).toEqual([
      '/api/v1/wallet/vouchers/v2/recipient',
      '/api/v1/wallet/vouchers/v2',
    ])
    expect(result.vouchers.map((v) => v.token)).toEqual(PARTS.map((id) => `cashu-${id}`))
  })

  it('delivers the whole face value the merchant sold', async () => {
    const result = await issueAndDeliver(params)

    const delivered = result.vouchers.reduce((sum, v) => sum + (v.face_value ?? 0), 0)
    // The customer is not short. This is the assertion the incident failed.
    expect(delivered).toBe(params.faceValueMinor)
  })

  it('sends each coupon its OWN token, never the first one repeated', async () => {
    await issueAndDeliver(params)

    const sent = bodies
      .filter((b) => 'token' in b)
      .map((b) => b.token as string)
    expect(new Set(sent).size).toBe(PARTS.length)
    expect(sent).toEqual(PARTS.map((id) => `cashu-${id}`))
  })

  it('records one history row per coupon, each at the PART value', async () => {
    await issueAndDeliver(params)

    expect(transactions).toHaveLength(PARTS.length)
    // Not the whole sale on every row, which would inflate the merchant's own
    // history fivefold for a single sale.
    for (const row of transactions) {
      expect(row.amount).toBe(PART_VALUE)
    }
  })

  it('still handles the ordinary one-coupon sale', async () => {
    PARTS.splice(1) // a sale small enough not to be split
    try {
      const result = await issueAndDeliver(params)
      expect(result.vouchers).toHaveLength(1)
      expect(deliveries()).toBe(1)
      // Even the one-coupon case is a LIST. There is no single-voucher field to
      // reach for, which is what stops the original bug being rewritten.
      expect(result.vouchers[0].voucher_id).toBe('v1')
    } finally {
      PARTS.push('v2', 'v3', 'v4', 'v5')
    }
  })
})

describe('what each coupon is recorded as being worth', () => {
  /**
   * The two spellings are not hypothetical. Probed against the deployed portal:
   * POST /api/v1/portal/vouchers returns `face_value_minor`, while the polled
   * GET /api/v1/wallet/vouchers/{id} returns `face_value` (and production logs
   * show `voucher_finalized ... face_value=20000`). Reading only one of them
   * leaves the amount undefined for half the pipeline.
   */
  it('reads face_value_minor when that is the spelling on offer', async () => {
    valueField = 'face_value_minor'

    const result = await issueAndDeliver(params)

    expect(transactions).toHaveLength(PARTS.length)
    for (const row of transactions) expect(row.amount).toBe(PART_VALUE)
    const sum = result.vouchers.reduce(
      (t, v) => t + (v.face_value ?? v.face_value_minor ?? 0),
      0,
    )
    expect(sum).toBe(params.faceValueMinor)
  })

  /**
   * The guard against the worst rounding error available here: filing the WHOLE
   * sale against each part, which would report five times the money as
   * delivered. An even share is wrong by pennies; the total is wrong by 400%.
   */
  it('never files the whole sale against a single part when the value is missing', async () => {
    valueField = 'none'

    await issueAndDeliver(params)

    expect(transactions).toHaveLength(PARTS.length)
    for (const row of transactions) {
      expect(row.amount).toBe(params.faceValueMinor / PARTS.length)
    }
    const total = transactions.reduce((t, r) => t + (r.amount as number), 0)
    expect(total).toBe(params.faceValueMinor)
  })
})

/**
 * Do the parts add up to the sale? Found in review.
 *
 * Each part reporting success is not the same claim as the customer receiving
 * what the merchant sold. The PORTAL chooses the split, so the pieces summing
 * to the whole is its promise, and nothing here was checking it — a gateway
 * returning four parts of a five-part split would have read as a clean sale.
 */
describe('reconciling the delivered total against the sale', () => {
  it('reports the delivered value, not the requested one', async () => {
    const result = await issueAndDeliver(params)
    expect(result.deliveredValue).toBe(params.faceValueMinor)
  })

  it('notices when the parts do not add up', async () => {
    const shout = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The portal returns one part fewer than the sale needs.
    PARTS.splice(4)
    try {
      const result = await issueAndDeliver(params)

      // Every part delivered, and the customer is still short a coupon. The
      // caller is handed the true figure rather than the intended one.
      expect(result.vouchers).toHaveLength(4)
      expect(result.deliveredValue).toBe(PART_VALUE * 4)
      expect(result.deliveredValue).not.toBe(params.faceValueMinor)
      expect(shout).toHaveBeenCalledWith(
        '[issue] the parts do not add up to the sale',
        expect.objectContaining({ requested: params.faceValueMinor }),
      )
    } finally {
      PARTS.push('v5')
    }
  })
})

describe('when a split sale fails halfway', () => {
  it('throws rather than reporting success for a partial delivery', async () => {
    failDeliveryFor.add('v3')

    // Silently resolving here is precisely what let a 200-of-1000 delivery be
    // reported to the merchant as a completed sale.
    await expect(issueAndDeliver(params)).rejects.toThrow()
  })

  it('tells the merchant how much already reached the customer', async () => {
    failDeliveryFor.add('v3')

    // Two parts landed before the failure: 2 x 200.00 = 400.00.
    await expect(issueAndDeliver(params)).rejects.toThrow(/400\.00 GBP/)
  })

  it('does not deliver any part after the failure', async () => {
    failDeliveryFor.add('v3')

    await expect(issueAndDeliver(params)).rejects.toThrow()
    // v1, v2 delivered; v3 attempted and refused; v4, v5 never attempted.
    expect(deliveries()).toBe(3)
  })

  it('still records the parts that DID land', async () => {
    failDeliveryFor.add('v3')

    await expect(issueAndDeliver(params)).rejects.toThrow()
    // The customer holds two coupons; the merchant's history must say so even
    // though the sale as a whole failed.
    expect(transactions).toHaveLength(2)
  })

  it('reports what landed when a later part never finishes minting', async () => {
    stallMintFor.add('v2')

    // Fake timers: the poll budget is 30 x 2s, and a test that waits it out in
    // real time costs a minute to assert something the clock is irrelevant to.
    vi.useFakeTimers()
    try {
      // A mint that never completes leaves the same question as a failed
      // delivery: how much is already gone? Here, one coupon.
      const run = issueAndDeliver(params)
      const assertion = expect(run).rejects.toThrow(/200\.00 GBP/)
      await vi.runAllTimersAsync()
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
