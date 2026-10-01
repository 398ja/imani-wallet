import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #95: redemptions recorded before #90 carry the gateway's random voucher id,
 * so the stall's claimed figure and the redemption ceiling cannot see them.
 * `reconcileClaims` re-files them from the voucher signed inside the coupon
 * each redemption wrote, under the same gates as a live claim.
 */

const STALL = 'f'.repeat(64)
const VOUCHER_ID = '1d4410af-70f5-4c14-8606-519404684ea7'

const store = vi.hoisted(() => ({
  txs: [] as Record<string, unknown>[],
  vouchers: [] as Record<string, unknown>[],
  published: [] as Record<string, unknown>[],
}))

vi.mock('../wallet', () => ({
  listTransactions: async () => store.txs,
  listVouchers: async () => store.vouchers,
  notifyWalletChanged: () => {},
  getWallet: () => ({
    updateTransaction: async (id: string, patch: Record<string, unknown>) => {
      const i = store.txs.findIndex((r) => r.id === id)
      if (i < 0) return null
      store.txs[i] = { ...store.txs[i], ...patch }
      return store.txs[i]
    },
  }),
}))
vi.mock('../txRecords', () => ({
  publishTx: async (row: Record<string, unknown>) => {
    store.published.push(row)
  },
}))

const { reconcileClaims, candidateClaim } = await import('../claimReconcile')
const { buildIssueTransaction, toTransaction } = await import('../transactions')
const { issuedVoucher } = await import('../issuedVoucher')
const { redeemLockName } = await import('../redemptionLedger')
const { buildVoucherToken } = await import('./voucherFixtures')

/** A stall's own voucher, face 1000 XAF, ratio 1 so sats == face units. */
const token = (sats: number, overrides: Record<string, unknown> = {}) =>
  buildVoucherToken(
    { issuerId: STALL, voucherId: VOUCHER_ID, faceValue: 1000, unit: 'XAF', faceDecimals: 0, issuanceRatio: 1, ...overrides },
    [sats],
  ).token

const issued = (amount = 1000) =>
  buildIssueTransaction({
    voucherId: VOUCHER_ID,
    amount,
    unit: 'XAF',
    decimals: 0,
    recipientPubkey: 'c'.repeat(64),
    at: 1_700_000_000_000,
  }) as unknown as Record<string, unknown>

/** A pre-#90 redemption: the row as the vendored builder wrote it, random id. */
function preFix(tokenId: string, tok: string, amount: number, at: number, extra: Record<string, unknown> = {}) {
  store.vouchers.push({ token_id: tokenId, token: tok, status: 'redeemed', issuer_id: STALL })
  store.txs.push({
    id: `received:${tokenId}`,
    type: 'received',
    direction: 'in',
    timestamp: at,
    amount,
    unit: 'XAF',
    decimals: 0,
    voucherId: crypto.randomUUID(),
    tokenId,
    ...extra,
  })
}

const record = () =>
  issuedVoucher(store.txs.map((r) => toTransaction(r as never)), VOUCHER_ID, {
    now: 1_700_000_000_000,
    stallPubkey: STALL,
  })!

beforeEach(() => {
  store.txs = [issued()]
  store.vouchers = []
  store.published = []
})

describe('reconcileClaims (#95)', () => {
  it('re-files pre-fix redemptions, so claimed and outstanding move', async () => {
    preFix('t1', token(400), 400, 1_700_000_100_000)
    preFix('t2', token(250), 250, 1_700_000_200_000)
    expect(record().claimedMinor).toBe(0)

    const result = await reconcileClaims(STALL)

    expect(result).toEqual({ filed: 2, unreadable: 0 })
    expect(record().claimedMinor).toBe(650)
    expect(record().outstandingMinor).toBe(350)
    // Traceable, and backed up so a restore does not bring the random id back.
    expect(store.txs[1].reconciledFromVoucherId).toEqual(expect.any(String))
    expect(store.published.map((r) => r.id)).toEqual(['received:t1', 'received:t2'])
  })

  it('is idempotent', async () => {
    preFix('t1', token(400), 400, 1_700_000_100_000)
    await reconcileClaims(STALL)
    const second = await reconcileClaims(STALL)
    expect(second.filed).toBe(0)
    expect(record().claimedMinor).toBe(400)
  })

  it('caps at what the issuance has left, oldest first', async () => {
    preFix('t1', token(700), 700, 1_700_000_100_000)
    preFix('t2', token(700), 700, 1_700_000_200_000)

    await reconcileClaims(STALL)

    expect(record().claimedMinor).toBe(1000)
    expect(record().outstandingMinor).toBe(0)
    expect(store.txs.find((r) => r.id === 'received:t2')!.amount).toBe(300)
  })

  it('files nothing without a local issued row', async () => {
    store.txs = []
    preFix('t1', token(400), 400, 1_700_000_100_000)
    expect(await reconcileClaims(STALL)).toEqual({ filed: 0, unreadable: 0 })
    expect(store.txs[0].voucherId).not.toBe(VOUCHER_ID)
  })

  it('files nothing across units', async () => {
    preFix('t1', token(400, { unit: 'EUR', faceDecimals: 2 }), 400, 1_700_000_100_000)
    await reconcileClaims(STALL)
    expect(record().claimedMinor).toBe(0)
  })

  it("files nothing for another stall's voucher, even under a live id", async () => {
    preFix('t1', token(400, { issuerId: 'a'.repeat(64) }), 400, 1_700_000_100_000)
    await reconcileClaims(STALL)
    expect(record().claimedMinor).toBe(0)
  })

  it('files nothing for a voucher whose signature does not verify', async () => {
    const forged = buildVoucherToken(
      { issuerId: STALL, voucherId: VOUCHER_ID, faceValue: 1000, unit: 'XAF', faceDecimals: 0, issuanceRatio: 1 },
      [400],
      { faceValue: 5000 },
    ).token
    preFix('t1', forged, 400, 1_700_000_100_000)
    await reconcileClaims(STALL)
    expect(record().claimedMinor).toBe(0)
  })

  it('counts a row whose coupon is not on this device, and leaves it alone', async () => {
    preFix('t1', token(400), 400, 1_700_000_100_000)
    store.vouchers = []
    expect(await reconcileClaims(STALL)).toEqual({ filed: 0, unreadable: 1 })
  })

  it('does not touch rows already filed against the issuance', async () => {
    store.txs.push({ id: 'received:done', type: 'received', timestamp: 1, amount: 300, unit: 'XAF', decimals: 0, voucherId: VOUCHER_ID, tokenId: 'done' })
    expect(await reconcileClaims(STALL)).toEqual({ filed: 0, unreadable: 0 })
  })

  it('re-files under the same Web Lock the till redeems under', async () => {
    preFix('t1', token(400), 400, 1_700_000_100_000)
    const names: string[] = []
    const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { locks: { request: (name: string, fn: () => Promise<unknown>) => (names.push(name), fn()) } },
    })
    try {
      await reconcileClaims(STALL)
      expect(names).toEqual([redeemLockName(VOUCHER_ID)])
    } finally {
      if (before) Object.defineProperty(globalThis, 'navigator', before)
      else delete (globalThis as { navigator?: unknown }).navigator
    }
  })
})

describe('candidateClaim', () => {
  it('prefers the attested figure the stall honoured at the time', () => {
    const claim = candidateClaim({ amount: 999, attestedValue: 380, attestedUnit: 'xaf' }, token(400), STALL)
    expect(claim).toMatchObject({ voucherId: VOUCHER_ID, amount: 380, unit: 'XAF' })
  })

  it('ignores an attested figure in another unit and uses the token value', () => {
    const claim = candidateClaim({ amount: 999, attestedValue: 380, attestedUnit: 'EUR' }, token(400), STALL)
    expect(claim?.amount).toBe(400)
  })

  it('refuses an unreadable token', () => {
    expect(candidateClaim({ amount: 1 }, 'cashuA-not-a-voucher', STALL)).toBeUndefined()
  })
})

describe('a stall whose only issuance is a cashback (#144)', () => {
  /** A cashback-only wallet is a stall, and its redemptions are filed against the cashback row. */
  it('files a cashback redemption against the cashback row', async () => {
    // Arrange
    const { buildCashbackTransaction } = await import('../transactions')
    store.txs = [
      buildCashbackTransaction({
        cashbackId: 'cb-1',
        claimCode: 'CB-ABCDE-FGHIJ',
        voucherId: VOUCHER_ID,
        amount: 1000,
        unit: 'XAF',
        decimals: 0,
        at: 1_700_000_000_000,
      }) as unknown as Record<string, unknown>,
    ]
    preFix('t1', token(400), 400, 1_700_000_100_000)

    // Act
    const result = await reconcileClaims(STALL)

    // Assert
    expect(result.filed).toBe(1)
    expect(record().row.type).toBe('cashback')
    expect(record().claimedMinor).toBe(400)
  })
})
