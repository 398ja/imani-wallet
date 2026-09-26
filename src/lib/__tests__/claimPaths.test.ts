import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

/**
 * #95: the vendored redemption paths that wrote a redemption without filing
 * its claim.
 *
 * A claim is filed only by `legacyBridge.stampCorrelation`, which runs on rows
 * written through `walletStorageIntegration.atomicallyWrite`. Two paths in
 * `shared/tokenRedemption.js` wrote around it; each is now pinned to what it
 * does instead. (`burn()`, the third, is pinned by `burnUnreachable.test.ts`.)
 *
 * The REAL `TokenRedemption` object, loaded the way the browser does (as a
 * classic script), with its free globals `api`, `walletStorageIntegration` and
 * `saveVoucher` supplied as doubles so what each path touches is observable.
 */

const SOURCE = readFileSync('shared/tokenRedemption.js', 'utf8')

interface Globals {
  api?: Record<string, unknown>
  walletStorageIntegration?: Record<string, unknown>
  saveVoucher?: (v: unknown) => unknown
}

type Redemption = {
  recoverPendingReceives(): Promise<number>
  _persistRedeemed(voucher: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<unknown>
  RedemptionSaveError: new (...args: unknown[]) => Error
}

function load(globals: Globals): Redemption {
  return new Function(
    'api',
    'walletStorageIntegration',
    'saveVoucher',
    `${SOURCE}; return TokenRedemption;`,
  )(globals.api, globals.walletStorageIntegration, globals.saveVoucher) as Redemption
}

describe('escrow recovery (#95 item 1)', () => {
  it('is disabled deliberately: files no claim, writes nothing, acknowledges nothing', async () => {
    const getPendingReceives = vi.fn(async () => [
      { receive_id: 'r-1', fresh_token: null, face_value: 400, face_unit: 'XAF', amount_sats: 20 },
    ])
    const acknowledgeReceive = vi.fn(async () => {})
    const saveVoucher = vi.fn()
    const atomicallyWrite = vi.fn()
    const redemption = load({
      api: { getPendingReceives, acknowledgeReceive },
      walletStorageIntegration: { atomicallyWrite },
      saveVoucher,
    })

    await expect(redemption.recoverPendingReceives()).resolves.toBe(0)
    // The old body asked the gateway, saved a random-id coupon with a bare
    // saveVoucher and then acknowledged the escrow. None of it happens now.
    expect(getPendingReceives).not.toHaveBeenCalled()
    expect(saveVoucher).not.toHaveBeenCalled()
    expect(atomicallyWrite).not.toHaveBeenCalled()
    expect(acknowledgeReceive).not.toHaveBeenCalled()
  })

  it('is called by nothing in the wallet', () => {
    // The disabled body is the belt; this is the braces. A new caller must
    // come with a claim-filing implementation, not by reviving the old one.
    const callers = [
      ...readFileSync('src/App.tsx', 'utf8').matchAll(/recoverPendingReceives/g),
      ...readFileSync('src/lib/dmPoll.ts', 'utf8').matchAll(/recoverPendingReceives/g),
      ...readFileSync('src/lib/legacyBridge.ts', 'utf8').matchAll(/recoverPendingReceives/g),
    ]
    expect(callers).toHaveLength(0)
    // And the vendored file calls only its own disabled entry point, never the
    // kept-for-reference body.
    expect(SOURCE).not.toMatch(/\._legacyRecoverPendingReceives\(/)
  })
})

describe('the non-atomic persist fallback (#95 item 2)', () => {
  const voucher = { voucher_id: 'v-1', token_id: 'tok-1', token: 'cashuB-x', face_value: 400, face_unit: 'XAF' }

  it('is gone: with no atomicallyWrite the save FAILS rather than writing an unclaimed coupon', async () => {
    const saveVoucher = vi.fn()
    const redemption = load({ walletStorageIntegration: {}, saveVoucher })

    await expect(redemption._persistRedeemed(voucher, { receiveId: 'r-1' })).rejects.toBeInstanceOf(
      redemption.RedemptionSaveError,
    )
    expect(saveVoucher).not.toHaveBeenCalled()
  })

  it('writes through atomicallyWrite, the path stampCorrelation patches, when it exists', async () => {
    const atomicallyWrite = vi.fn(async () => {})
    const saveVoucher = vi.fn()
    const redemption = load({ walletStorageIntegration: { atomicallyWrite }, saveVoucher })

    await redemption._persistRedeemed(voucher, {})

    expect(atomicallyWrite).toHaveBeenCalledTimes(1)
    const [input] = atomicallyWrite.mock.calls[0] as unknown as [{ transactions: unknown[] }]
    expect(input.transactions).toHaveLength(1)
    expect(saveVoucher).not.toHaveBeenCalled()
  })

  it('leaves no bare saveVoucher call anywhere in the vendored redemption path', () => {
    // Only the kept-for-reference escrow body may still spell it.
    const live = SOURCE.replace(/async _legacyRecoverPendingReceives\(\)[\s\S]*?\n {4}\}\n/, '')
    expect(live).not.toMatch(/[^.\w]saveVoucher\(/)
  })
})
