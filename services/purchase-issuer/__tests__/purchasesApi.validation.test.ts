import { describe, expect, it, vi } from 'vitest'

import { MAX_FACE_VALUE_MINOR, parseOwedPurchase, PurchasesApi } from '../purchasesApi'

/**
 * Regression tests for IW-07 (Critical).
 *
 * The debt queue response was trusted verbatim — `body as OwedPurchase[]`, a cast, which is a
 * promise to the type checker and no check at all at runtime. Every field was then used as
 * authoritative: `amountMinor` became the coupon's face value with no range, type, integrality
 * or sign check, and `recipientPubkey` decided who received it.
 *
 * This worker mints real value unsupervised with `livemode: true`, and its only input is an HTTP
 * response from `PURCHASE_API_URL` — a plaintext intra-cluster hop. Anyone able to influence
 * that response controlled the mint: a single crafted row minted a coupon for any amount,
 * signed by a real stall's own issuing credential, delivered to an attacker's pubkey. The stall
 * is liable; the stall was asleep.
 */

const STALL = 'a'.repeat(64)
const RECIPIENT = 'b'.repeat(64)

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt_1',
    paymentRequestId: 'pr_1',
    stallPubkey: STALL,
    recipientPubkey: RECIPIENT,
    amountMinor: 1500,
    currency: 'GBP',
    livemode: true,
    attempts: 0,
    ...overrides,
  }
}

describe('IW-07: the debt queue is a trust boundary', () => {
  describe('parseOwedPurchase', () => {
    it('accepts a well-formed row', () => {
      expect(parseOwedPurchase(validRow())).toMatchObject({
        eventId: 'evt_1',
        amountMinor: 1500,
        currency: 'GBP',
        livemode: true,
      })
    })

    it('accepts the meaningful nulls: issue by hand, and claim-link delivery', () => {
      // Null on these keys is a real state, not a missing field, so it must survive validation.
      expect(parseOwedPurchase(validRow({ stallPubkey: null }))).not.toBeNull()
      expect(parseOwedPurchase(validRow({ recipientPubkey: null }))).not.toBeNull()
    })

    describe('the face value, which decides how much is minted', () => {
      it('refuses the attacker amount from the finding', () => {
        // A GBP 1,000,000 coupon signed by a stall that never agreed to it.
        expect(parseOwedPurchase(validRow({ amountMinor: 100000000 }))).toBeNull()
      })

      it('refuses anything above the ceiling', () => {
        expect(parseOwedPurchase(validRow({ amountMinor: MAX_FACE_VALUE_MINOR + 1 }))).toBeNull()
        expect(parseOwedPurchase(validRow({ amountMinor: MAX_FACE_VALUE_MINOR }))).not.toBeNull()
      })

      it('refuses zero, negative and non-integer amounts', () => {
        expect(parseOwedPurchase(validRow({ amountMinor: 0 }))).toBeNull()
        expect(parseOwedPurchase(validRow({ amountMinor: -500 }))).toBeNull()
        expect(parseOwedPurchase(validRow({ amountMinor: 12.34 }))).toBeNull()
      })

      it('refuses a non-number, including a numeric string', () => {
        expect(parseOwedPurchase(validRow({ amountMinor: '1500' }))).toBeNull()
        expect(parseOwedPurchase(validRow({ amountMinor: null }))).toBeNull()
        expect(parseOwedPurchase(validRow({ amountMinor: undefined }))).toBeNull()
        expect(parseOwedPurchase(validRow({ amountMinor: NaN }))).toBeNull()
      })
    })

    describe('the keys, which decide who is liable and who is paid', () => {
      it('refuses a malformed recipient pubkey', () => {
        expect(parseOwedPurchase(validRow({ recipientPubkey: 'not-a-key' }))).toBeNull()
        expect(parseOwedPurchase(validRow({ recipientPubkey: 'ab' }))).toBeNull()
      })

      it('refuses a malformed stall pubkey', () => {
        expect(parseOwedPurchase(validRow({ stallPubkey: 'nope' }))).toBeNull()
      })
    })

    describe('the currency, which drives faceDecimals', () => {
      it('refuses a non-ISO-4217 code', () => {
        // getDecimals() is called on this string and a faceValue/faceDecimals disagreement is
        // the 5000-XAF-becomes-50 class of bug.
        expect(parseOwedPurchase(validRow({ currency: 'POUNDS' }))).toBeNull()
        expect(parseOwedPurchase(validRow({ currency: '' }))).toBeNull()
        expect(parseOwedPurchase(validRow({ currency: 12 }))).toBeNull()
      })
    })

    describe('livemode, which decides whether real value is minted', () => {
      it('refuses a truthy string rather than treating it as true', () => {
        // `livemode: "false"` is truthy. Real value must never be minted from a test payment
        // because a string looked like a boolean.
        expect(parseOwedPurchase(validRow({ livemode: 'false' }))).toBeNull()
        expect(parseOwedPurchase(validRow({ livemode: 1 }))).toBeNull()
      })
    })

    it('refuses rows that are not objects at all', () => {
      expect(parseOwedPurchase(null)).toBeNull()
      expect(parseOwedPurchase('string')).toBeNull()
      expect(parseOwedPurchase([])).toBeNull()
      expect(parseOwedPurchase(42)).toBeNull()
    })

    it('refuses missing identifiers', () => {
      expect(parseOwedPurchase(validRow({ eventId: '' }))).toBeNull()
      expect(parseOwedPurchase(validRow({ paymentRequestId: undefined }))).toBeNull()
    })
  })

  describe('owed()', () => {
    function apiReturning(body: unknown, onInvalidRow?: (row: unknown) => void) {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => body,
      }) as unknown as typeof fetch
      return new PurchasesApi('http://purchases.test', 'token', fetchImpl, onInvalidRow)
    }

    it('drops the crafted row and keeps the genuine one', async () => {
      const crafted = validRow({ eventId: 'evt_evil', amountMinor: 100000000 })
      const genuine = validRow({ eventId: 'evt_good' })

      const owed = await apiReturning([crafted, genuine]).owed()

      expect(owed).toHaveLength(1)
      expect(owed[0].eventId).toBe('evt_good')
    })

    it('reports every dropped row rather than skipping it silently', async () => {
      // A silent drop turns "we refused to mint from a malformed row" into "that purchase never
      // arrived", which looks like a queue problem and hides an attack.
      const onInvalidRow = vi.fn()
      await apiReturning([validRow({ amountMinor: -1 }), 'garbage'], onInvalidRow).owed()

      expect(onInvalidRow).toHaveBeenCalledTimes(2)
    })

    it('returns nothing when the response is not an array', async () => {
      expect(await apiReturning({ not: 'an array' }).owed()).toEqual([])
    })
  })
})
