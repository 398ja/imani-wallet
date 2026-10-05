/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { RedemptionRefusedError } from '@imani/dm-poll'

/**
 * Issue #159, Option B: EVERY recipient refuses an unauthorised coupon.
 *
 * `refuseIfUnwarranted` has no merchant guard, unlike `refuseIfAnotherStalls`,
 * and that is the decision: a customer's wallet refuses a coupon whose warrant
 * is `absent`, `unwarranted` (a signed `none`) or `failed`, exactly as the
 * issuing stall's till would. Letting customers hold them instead (Option A)
 * would let a customer pay for a coupon the stall that issued it then refuses.
 *
 * Driven through the adapter `startDmPoll` installs, for a wallet with NO
 * stall record, so the assertion covers what a customer actually runs: the
 * cross-stall check stands aside (not a stall), the warrant check refuses,
 * and the mint is never asked to swap, so the coupon stays the sender's.
 *
 * The issuing-stall side of the same refusal is `refuseIfUnwarranted.test.ts`.
 */

const stubs = vi.hoisted(() => ({
  merchant: null as Record<string, unknown> | null,
  /** Every token handed to the mint. Must stay EMPTY on a refusal. */
  swapped: [] as string[],
  /** Every refusal the wallet announced to the stall. */
  announced: [] as unknown[],
}))

vi.mock('../merchant', () => ({
  loadMerchant: () => stubs.merchant,
  MERCHANT_KIND: 30078,
}))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({}),
  // Passes the work through so the adapter's real ordering is preserved.
  withCorrelation: async (_ids: unknown, run: () => unknown) => run(),
}))
vi.mock('../wallet', () => ({
  listTransactions: async () => [],
  getWallet: () => ({}),
  notifyWalletChanged: () => {},
  recordReceiptByNullifier: async () => {},
}))
vi.mock('../relay', () => ({ allEvents: async () => [], publish: async () => ({ ok: 1 }) }))
vi.mock('../arrivalToast', () => ({
  announceArrival: () => {},
  announceBundleArrival: async () => {},
  resumeBundleArrivals: () => {},
  stopBundleArrivals: () => {},
}))
vi.mock('../queuedToast', () => ({ announceQueued: () => {}, settleQueued: () => {} }))
vi.mock('../paymentReceipt', () => ({ postPaymentReceipt: () => {} }))
vi.mock('../attestation', () => ({
  attestRedemption: async () => null,
  nullifierFor: () => 'n'.repeat(64),
}))
// sonner touches the DOM at import; the held-coupon toast is its own module for that reason (#133 review).
vi.mock('../heldToast', () => ({ announceHeld: () => {} }))
vi.mock('../refusalToast', () => ({
  announceRefusal: (e: unknown) => stubs.announced.push(e),
}))

import { startDmPoll, stopDmPoll } from '../dmPoll'
import type { VoucherValidation } from '../voucherToken'
import { buildVoucherToken } from './voucherFixtures'

/** A shopper's key. Has no stall record (`loadMerchant` answers null). */
const CUSTOMER = 'cd'.repeat(32)

function validation(warrant: VoucherValidation['warrant']): VoucherValidation {
  return {
    signatureValid: true,
    legacyCanonical: false,
    signedFaceValue: 400,
    cappedAtFaceValue: false,
    warrant,
  }
}

function installedAdapter() {
  const service = startDmPoll(CUSTOMER) as unknown as {
    config: { redemptionAdapter: { redeem: (t: string, o?: unknown) => Promise<unknown> } }
  }
  return service.config.redemptionAdapter
}

function receive(warrant: VoucherValidation['warrant']) {
  const { token, voucher } = buildVoucherToken({ faceValue: 400, unit: 'GBP' })
  const run = installedAdapter().redeem(token, {
    metadata: {
      issuerId: voucher.issuerId,
      voucherId: 'v-1',
      faceValue: 400,
      validation: validation(warrant),
    },
  } as never)
  return { token, run }
}

beforeEach(() => {
  // A customer: no stall record at all.
  stubs.merchant = null
  stubs.swapped = []
  stubs.announced = []
  ;(window as unknown as Record<string, unknown>).TokenRedemption = {
    redeem: async (token: string) => {
      stubs.swapped.push(token)
      return { voucher_id: 'v', amount: 400, unit: 'GBP', decimals: 2 }
    },
  }
})

afterEach(() => {
  stopDmPoll()
  delete (window as unknown as Record<string, unknown>).TokenRedemption
})

describe('a customer wallet receiving an unauthorised coupon by DM', () => {
  for (const warrant of ['absent', 'unwarranted', 'failed'] as const) {
    it(`refuses a coupon whose warrant is \`${warrant}\`, before the mint swap`, async () => {
      const { run } = receive(warrant)

      await expect(run).rejects.toBeInstanceOf(RedemptionRefusedError)
      await expect(run).rejects.toMatchObject({ reason: 'unwarranted' })
      expect(stubs.swapped).toEqual([])
    })
  }

  it('takes a coupon whose merchant warrant verified', async () => {
    // The control: without it, an adapter that threw on everything would make
    // the refusals above look like a working check.
    const { token, run } = receive('verified')

    await run

    expect(stubs.swapped).toEqual([token])
  })

  it('takes a coupon whose validation predates the warrant field', async () => {
    const { token, run } = receive(undefined)

    await run

    expect(stubs.swapped).toEqual([token])
  })
})
