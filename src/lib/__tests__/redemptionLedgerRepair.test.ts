import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransactionRow, VoucherRow } from '@imani/wallet-storage'

/**
 * #145: song's till refused the last honest part of voucher 19c4fed1.
 *
 * Staging, song (the issuer) received 19c4fed1's parts over two days: 137, 68,
 * 616 and 206 sats, 1027 sats in all, 74.91 of the face of 100. On 09-30 at
 * 03:35:22 the 206-sat part and a 1365-sat coupon of ANOTHER voucher were
 * redeemed 21 ms apart. The bridge kept one correlation slot, so the other
 * coupon's row was stamped with 19c4fed1's claim and 19c4fed1's own row was
 * re-filed from its token later. 19c4fed1 then carried two rows for the 206
 * part: 89.93 booked, and the honest last part (208 sats, 15.17) did not fit.
 *
 * The write side is fixed in legacyBridge. These rows are already on song's
 * device, so the ledger has to read past them: a row whose own coupon names
 * a different voucher is not a redemption of this one, and one redemption
 * (one nullifier, one transfer id) counts once.
 */

const store = vi.hoisted(() => ({ rows: [] as TransactionRow[], coupons: [] as VoucherRow[] }))
vi.mock('../wallet', () => ({
  listTransactions: async () => store.rows,
  listVouchers: async () => store.coupons,
}))

const { checkPart } = await import('../redemptionLedger')
const { buildVoucherToken } = await import('./voucherFixtures')
const { exactFaceValue, parseVoucherToken } = await import('../voucherToken')

const SONG_VOUCHER = '19c4fed1-0000-4000-8000-000000000001'
const OTHER_VOUCHER = 'b0b0b0b0-0000-4000-8000-000000000002'
/** 19c4fed1's ratio as staging's receive_escrow carries it. */
const SONG_RATIO = 0.07293946024799416
/** The other voucher redeemed beside the 206 part. */
const OTHER_RATIO = 0.07326007
const FACE = 100

/** A real signed coupon of `voucherId` carrying `sats`. */
const coupon = (voucherId: string, ratio: number, sats: number) =>
  buildVoucherToken({ voucherId, faceValue: FACE, unit: 'EUR', faceDecimals: 2, issuanceRatio: ratio }, [sats]).token

const exactOf = (token: string) => exactFaceValue(parseVoucherToken(token))

/**
 * One redemption as the till stores it: the coupon row (the swapped token,
 * which keeps the signed voucher) and its `received:<tokenId>` row.
 */
function redeemed(
  tokenId: string,
  token: string,
  row: { voucherId: string; amount: number; exact: number; nullifier?: string; transferId?: string },
) {
  store.coupons.push({ token_id: tokenId, token, status: 'redeemed' } as unknown as VoucherRow)
  store.rows.push({
    id: `received:${tokenId}`,
    type: 'received',
    timestamp: 1,
    amount: row.amount,
    exactValue: row.exact,
    unit: 'EUR',
    decimals: 2,
    voucherId: row.voucherId,
    tokenId,
    attestationNullifier: row.nullifier,
    transferId: row.transferId,
  } as unknown as TransactionRow)
}

/**
 * song's four genuine redemptions of 19c4fed1, booked by cumulative credit.
 * The 206 part is the row the race left unstamped, so it carries no nullifier
 * and was filed under 19c4fed1 later by `claimReconcile` from its own token.
 */
function songsGenuineParts() {
  const credits = [9, 5, 45, 15]
  ;[137, 68, 616, 206].forEach((sats, i) => {
    const token = coupon(SONG_VOUCHER, SONG_RATIO, sats)
    redeemed(`tok-${sats}`, token, {
      voucherId: SONG_VOUCHER,
      amount: credits[i],
      exact: exactOf(token),
      nullifier: sats === 206 ? undefined : `n-${sats}`,
    })
  })
}

/**
 * The other coupon's row, stamped with the 206 part's claim AND its nullifier
 * by the race. Nothing it carries ties it to the genuine 206 row, so only its
 * own coupon can show it is not 19c4fed1's.
 */
function misfiledOtherCoupon() {
  const token206 = coupon(SONG_VOUCHER, SONG_RATIO, 206)
  redeemed('tok-1365', coupon(OTHER_VOUCHER, OTHER_RATIO, 1365), {
    voucherId: SONG_VOUCHER,
    amount: 15,
    exact: exactOf(token206),
    nullifier: 'n-206',
  })
}

const lastPart = () => exactOf(coupon(SONG_VOUCHER, SONG_RATIO, 208))

beforeEach(() => {
  store.rows = []
  store.coupons = []
})

describe("song's ledger for voucher 19c4fed1 (#145)", () => {
  /** The staging sequence: the race left a second row on 19c4fed1, and the honest 208-sat part must still be taken. */
  it('accepts the honest 208-sat last part despite the misfiled row', async () => {
    // Arrange
    songsGenuineParts()
    misfiledOtherCoupon()

    // Act
    const { credit, check } = await checkPart({ voucherId: SONG_VOUCHER, exact: lastPart(), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(true)
    expect(credit).toBe(16)
  })

  /** Without the misfiled row the same part fits, so the duplicate alone explains the refusal and no residual tolerance is needed. */
  it('needs no residual tolerance: the clean ledger takes the same part', async () => {
    // Arrange
    songsGenuineParts()

    // Act
    const { check } = await checkPart({ voucherId: SONG_VOUCHER, exact: lastPart(), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(true)
  })

  /** A row whose coupon cannot be read is kept: unknown is counted, never waved through. */
  it('still counts a row whose coupon is not on this device', async () => {
    // Arrange: 19c4fed1 fully redeemed, the coupon rows gone (spent on, or a restore).
    songsGenuineParts()
    store.coupons = []
    store.rows.push({
      id: 'received:tok-rest',
      type: 'received',
      timestamp: 1,
      amount: 25,
      exactValue: 25.09,
      unit: 'EUR',
      decimals: 2,
      voucherId: SONG_VOUCHER,
      tokenId: 'tok-rest',
    } as unknown as TransactionRow)

    // Act
    const { check } = await checkPart({ voucherId: SONG_VOUCHER, exact: lastPart(), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(false)
  })

  /** One redemption carried by two rows (one nullifier) is booked once. */
  it('counts two rows sharing a nullifier once', async () => {
    // Arrange: the 616 part twice under one nullifier, the copy's coupon gone.
    songsGenuineParts()
    store.rows.push({
      id: 'received:tok-dup',
      type: 'received',
      timestamp: 1,
      amount: 45,
      exactValue: 44.93,
      unit: 'EUR',
      decimals: 2,
      voucherId: SONG_VOUCHER,
      tokenId: 'tok-dup',
      attestationNullifier: 'n-616',
    } as unknown as TransactionRow)

    // Act
    const { check } = await checkPart({ voucherId: SONG_VOUCHER, exact: lastPart(), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(true)
  })
})

describe('the ceiling still holds after the repair (#145)', () => {
  /** Two distinct genuine redemptions both count, so the face cannot be taken twice. */
  it('refuses a part beyond the face when every prior is a distinct genuine redemption', async () => {
    // Arrange: all of 19c4fed1 redeemed honestly, 1371 sats.
    songsGenuineParts()
    for (const sats of [208, 136]) {
      const token = coupon(SONG_VOUCHER, SONG_RATIO, sats)
      redeemed(`tok-${sats}`, token, { voucherId: SONG_VOUCHER, amount: 0, exact: exactOf(token), nullifier: `n-${sats}` })
    }

    // Act
    const { check } = await checkPart({
      voucherId: SONG_VOUCHER,
      exact: exactOf(coupon(SONG_VOUCHER, SONG_RATIO, 1)),
      signedFaceValue: FACE,
    })

    // Assert
    expect(check.allowed).toBe(false)
  })

  /** Every honest part of the real 1371-sat split fits exactly at the real ratio, with no allowance. */
  it('takes the whole honest split at the real ratio, part by part', async () => {
    // Arrange
    const parts = [137, 68, 616, 206, 208, 136]

    // Act
    const verdicts: boolean[] = []
    for (const sats of parts) {
      const token = coupon(SONG_VOUCHER, SONG_RATIO, sats)
      const { credit, check } = await checkPart({ voucherId: SONG_VOUCHER, exact: exactOf(token), signedFaceValue: FACE })
      verdicts.push(check.allowed)
      redeemed(`tok-${sats}`, token, { voucherId: SONG_VOUCHER, amount: credit, exact: exactOf(token), nullifier: `n-${sats}` })
    }

    // Assert
    expect(verdicts).toEqual(parts.map(() => true))
    expect(store.rows.reduce((sum, r) => sum + Number((r as unknown as { amount: number }).amount), 0)).toBe(FACE)
  })

  /** A repeat presentation of one genuine coupon under a fresh nullifier is not a duplicate and still counts. */
  it('does not merge two rows that only share a voucher', async () => {
    // Arrange: 95 of the face booked in two genuine parts.
    const first = coupon(SONG_VOUCHER, SONG_RATIO, 685)
    const second = coupon(SONG_VOUCHER, SONG_RATIO, 617)
    redeemed('tok-a', first, { voucherId: SONG_VOUCHER, amount: 49, exact: exactOf(first), nullifier: 'n-a' })
    redeemed('tok-b', second, { voucherId: SONG_VOUCHER, amount: 45, exact: exactOf(second), nullifier: 'n-b' })

    // Act
    const { check } = await checkPart({ voucherId: SONG_VOUCHER, exact: lastPart(), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(false)
  })
})
