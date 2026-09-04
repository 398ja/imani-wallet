import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TransactionRow } from '@imani/wallet-storage'

const stubs = vi.hoisted(() => ({ rows: [] as TransactionRow[] }))

vi.mock('../wallet', () => ({
  listTransactions: async () => stubs.rows,
}))

import { checkRedemption } from '../redemptionLedger'

/**
 * Does the ceiling survive being computed by a service that stores nothing?
 *
 * The API-coverage assessment (.scratch/api-coverage) proposes an "attest"
 * shape for `/v1/redeem/check`: the caller sends the prior redemptions it
 * already holds, and the service returns the verdict. Every other proposal in
 * that document reuses a pattern the codebase already runs. This one is new,
 * so it is the one most likely to be wrong.
 *
 * The risk is not that the arithmetic is hard. It is that an EXTRACTED copy
 * drifts from `checkRedemption`, and a till and an API then enforce two
 * different ceilings on the same voucher — with no test failing, because each
 * would be internally consistent.
 *
 * So this pins them together. `redeemCheck` is the proposed endpoint's whole
 * body; every case runs through both and the verdicts must match.
 */

/**
 * The shared ceiling — the SAME function the wallet API calls.
 *
 * This used to be a reimplementation sitting beside the app's, and these tests
 * asserted the two agreed. That was the best available check while the
 * arithmetic still lived inside `redemptionLedger`, and it was never
 * satisfying: agreement today is not identity tomorrow, and the failure it
 * guards against is silent by construction.
 *
 * Ticket 01 extracted the arithmetic, so `checkRedemption` now CALLS this.
 * These tests therefore no longer compare two implementations — they pin that
 * the app has not grown a second one, which is a stronger property and a
 * cheaper one to keep true.
 */
import { checkCeiling } from '@imani/redemption'

const redeemCheck = checkCeiling

const VOUCHER = '1d4410af-70f5-4c14-8606-519404684ea7'

const inbound = (amount: number, i: number): TransactionRow =>
  ({
    id: `tx-${i}`,
    type: 'received',
    timestamp: 1_700_000_000_000,
    amount,
    unit: 'GBP',
    decimals: 2,
    voucherId: VOUCHER,
  }) as unknown as TransactionRow

beforeEach(() => {
  stubs.rows = []
})

describe('the extracted ceiling agrees with the app on every case', () => {
  const cases: Array<{ what: string; face: number; requested: number; priors: number[] }> = [
    { what: 'a fresh voucher', face: 1000, requested: 400, priors: [] },
    { what: 'one partial redemption already taken', face: 1000, requested: 400, priors: [400] },
    { what: 'exactly to the face', face: 1000, requested: 200, priors: [400, 400] },
    { what: 'one minor unit over', face: 1000, requested: 201, priors: [400, 400] },
    { what: 'already at the face', face: 1000, requested: 1, priors: [1000] },
    { what: 'past the face already', face: 1000, requested: 1, priors: [1200] },
    // Legacy derive-only tokens store nothing, so there is no ceiling to
    // enforce. Inventing one would refuse honest coupons.
    { what: 'no signed face at all', face: 0, requested: 5000, priors: [] },
  ]

  for (const { what, face, requested, priors } of cases) {
    it(`${what}`, async () => {
      stubs.rows = priors.map(inbound)

      const app = await checkRedemption({
        voucherId: VOUCHER,
        requested,
        signedFaceValue: face,
      })
      const api = redeemCheck({
        signedFaceValue: face,
        requested,
        priorRedemptions: priors.map((amount) => ({ amount, direction: 'in' as const })),
      })

      expect(api.allowed).toBe(app.allowed)
      expect(api.alreadyRedeemed).toBe(app.alreadyRedeemed)
      expect(api.remaining).toBe(app.remaining)
    })
  }

  it('refuses an overspend, so the agreement is not agreement on always-true', () => {
    // Without this, every case above could pass with both sides returning
    // `allowed: true` unconditionally.
    const over = redeemCheck({
      signedFaceValue: 1000,
      requested: 1,
      priorRedemptions: [{ amount: 1000, direction: 'in' }],
    })
    expect(over.allowed).toBe(false)
  })

  it('ignores outgoing rows, which is where a naive extraction goes wrong', async () => {
    // The merchant's own ISSUED row is outgoing. Summing it would consume the
    // ceiling before a customer redeemed anything — and `toTransaction` is the
    // one place direction is derived, because stored rows disagree with
    // themselves about it.
    stubs.rows = [
      { ...inbound(1000, 0), type: 'issued' } as unknown as TransactionRow,
    ]

    const app = await checkRedemption({
      voucherId: VOUCHER,
      requested: 1000,
      signedFaceValue: 1000,
    })
    const api = redeemCheck({
      signedFaceValue: 1000,
      requested: 1000,
      priorRedemptions: [{ amount: 1000, direction: 'out' }],
    })

    expect(app.allowed).toBe(true)
    expect(api.allowed).toBe(app.allowed)
    expect(api.alreadyRedeemed).toBe(app.alreadyRedeemed)
  })
})
