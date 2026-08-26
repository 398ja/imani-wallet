import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { installTokenIdFill, withCorrelation } from '../legacyBridge'

/**
 * The correlation must survive the token swap.
 *
 * `TokenRedemption.redeem()` swaps the coupon at the mint, so the row it
 * writes is keyed on the fingerprint of a token that did not exist when the DM
 * arrived. An earlier version registered the ids under the RECEIVED token's
 * fingerprint, which matched nothing on staging: every arrival persisted with
 * `bundleId: null` and no merchant till could settle a bundled payment.
 */
describe('withCorrelation', () => {
  let written: { vouchers?: unknown[]; transactions?: unknown[] }[]
  // Tests run in node, not jsdom; the bridge only ever touches this one global.
  const scope = globalThis as unknown as { window: Window }

  beforeEach(() => {
    written = []
    scope.window = globalThis as unknown as Window
    window.walletStorageIntegration = {
      init: vi.fn(),
      atomicallyWrite: async (input) => {
        written.push(input)
      },
    }
    installTokenIdFill()
  })

  const write = (tokenId: string) =>
    window.walletStorageIntegration!.atomicallyWrite({
      // The vendored builder writes `null`, not `undefined`.
      transactions: [{ id: `received:${tokenId}`, tokenId, bundleId: null }],
    })

  it('stamps a row whose token id is not the received token', async () => {
    await withCorrelation({ bundleId: 'bundle-1', requestId: 'abe0b88b650a39cd' }, () =>
      write('post-swap-token-id'),
    )

    expect(written[0].transactions).toEqual([
      expect.objectContaining({ bundleId: 'bundle-1', requestId: 'abe0b88b650a39cd' }),
    ])
  })

  it('does not leak ids onto a write outside the redeem', async () => {
    await withCorrelation({ requestId: 'r1' }, async () => {})
    await write('unrelated')

    expect(written[0].transactions).toEqual([expect.objectContaining({ bundleId: null })])
    expect((written[0].transactions as Record<string, unknown>[])[0].requestId).toBeUndefined()
  })

  it('clears the slot when the redeem throws', async () => {
    await expect(
      withCorrelation({ requestId: 'r1' }, async () => {
        throw new Error('mint down')
      }),
    ).rejects.toThrow('mint down')

    await write('next-coupon')
    expect((written[0].transactions as Record<string, unknown>[])[0].requestId).toBeUndefined()
  })
})

/**
 * The merchant's "Checks" section, end to end through the REAL vendored builder.
 *
 * Reported: after sending a coupon, the redemption screen showed no validation
 * — every arrival read "Not checked" even though the wallet had verified the
 * issuer's signature and refused anything that failed.
 *
 * The loss took two steps, and each looked correct on its own:
 *
 *  1. `_buildReceiveTransactionRow` returns null without a `token_id`, and the
 *     voucher reaches `_persistRedeemed` without one because shared/storage.js
 *     — which would synthesise it — is never loaded here. So tokenRedemption
 *     writes `transactions: []`.
 *  2. `installTokenIdFill` fills the id in and rebuilds the row, but calls the
 *     builder with EMPTY metadata, so `metadata.validation` is dropped.
 *
 * The builder genuinely does read `metadata.validation`, and dm-poll genuinely
 * does pass it. Neither helps, because the branch that reads it never produces
 * a row. `receiveTransactionRow.test.ts` covers the builder in isolation and
 * passes throughout — which is exactly why this needs the real thing wired to
 * the real fallback.
 */
describe('the Checks a redeemed coupon carries', () => {
  const buildRow = new Function(
    readFileSync('shared/tokenRedemption.js', 'utf8') + '; return _buildReceiveTransactionRow;',
  )() as (v: Record<string, unknown>, m?: Record<string, unknown>) => Record<string, unknown> | null

  const validation = {
    signatureValid: true,
    legacyCanonical: true,
    signedFaceValue: 1000,
    cappedAtFaceValue: false,
  }

  let written: { vouchers?: unknown[]; transactions?: unknown[] }[]
  const scope = globalThis as unknown as { window: Window }

  beforeEach(() => {
    written = []
    scope.window = globalThis as unknown as Window
    // The builder is a classic-script global in production; installTokenIdFill
    // looks it up on globalThis, so put the real one there.
    ;(globalThis as unknown as Record<string, unknown>)._buildReceiveTransactionRow = buildRow
    window.walletStorageIntegration = {
      init: vi.fn(),
      atomicallyWrite: async (input) => {
        written.push(input)
      },
    }
    installTokenIdFill()
  })

  /**
   * A coupon at the write, with `transactions: []` — which is the state
   * tokenRedemption leaves it in, because the builder returned null for want of
   * a token_id. `token_id` is set here so the fill's own hashing path (which
   * needs a real cashu token) is not what this test is about.
   */
  const redeem = () =>
    window.walletStorageIntegration!.atomicallyWrite({
      vouchers: [
        {
          token_id: 'tok-1',
          voucher_id: 'vou-1',
          face_value: 1000,
          face_unit: 'XAF',
        },
      ],
      transactions: [],
    })

  it('records what was verified, on the row the merchant actually reads', async () => {
    await withCorrelation({ validation }, redeem)

    const rows = written[0].transactions as Record<string, unknown>[]
    expect(rows, 'the rebuild must produce a row at all').toHaveLength(1)
    expect(
      rows[0].validation,
      'without this the Checks section reads "Not checked" on a verified coupon',
    ).toEqual(validation)
  })

  it('leaves plain ecash unmarked, because silence must not read as a pass', async () => {
    // No issuer claim to check: absent validation is the honest answer, and the
    // detail screen renders it as "Not checked".
    await withCorrelation({ bundleId: 'b1' }, redeem)

    const rows = written[0].transactions as Record<string, unknown>[]
    expect(rows[0].validation).toBeUndefined()
  })

  it('does not overwrite a verification the builder already recorded', async () => {
    const own = { ...validation, signedFaceValue: 42 }
    await withCorrelation({ validation }, () =>
      window.walletStorageIntegration!.atomicallyWrite({
        transactions: [{ id: 'received:tok', validation: own }],
      }),
    )

    expect((written[0].transactions as Record<string, unknown>[])[0].validation).toEqual(own)
  })

  it('does not leak one coupon\'s checks onto the next', async () => {
    await withCorrelation({ validation }, redeem)
    await redeem()

    const second = written[1].transactions as Record<string, unknown>[]
    expect(second[0].validation).toBeUndefined()
  })
})
