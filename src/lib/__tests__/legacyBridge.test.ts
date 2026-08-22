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
