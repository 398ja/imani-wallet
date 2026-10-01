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

const { checkPart, repairedTransactions } = await import('../redemptionLedger')
const { claimToFile } = await import('../merchantClaim')
const { issuedVoucher } = await import('../issuedVoucher')

/** song's key: the stall that issued both vouchers. */
const STALL = 'e'.repeat(64)
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

/**
 * song issued both vouchers, so both have an `issued` row. The repair only
 * re-files rows against a stall's own issuances (see redemptionRows.ts).
 */
const issuedRow = (voucherId: string) =>
  ({ id: `issued:${voucherId}`, type: 'issued', timestamp: 1, amount: FACE, unit: 'EUR', decimals: 2, voucherId }) as unknown as TransactionRow

beforeEach(() => {
  store.rows = [issuedRow(SONG_VOUCHER), issuedRow(OTHER_VOUCHER)]
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
    const received = store.rows.filter((r) => (r as unknown as { type: string }).type === 'received')
    expect(received.reduce((sum, r) => sum + Number((r as unknown as { amount: number }).amount), 0)).toBe(FACE)
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

/**
 * Review of #145 (F1): dropping a misfiled row from the voucher it was stamped
 * with is only half a repair. The coupon it carries is a real redemption of
 * ANOTHER voucher, and that voucher's ceiling must still see it, or the till
 * would take the same face of it twice.
 */
describe('a misfiled row still counts against the voucher its coupon names (#145 review)', () => {
  const tokenA206 = () => coupon(SONG_VOUCHER, SONG_RATIO, 206)
  const tokenB1365 = () => coupon(OTHER_VOUCHER, OTHER_RATIO, 1365)

  /** The mirror swap: each coupon's row carries the other's stamp. B was redeemed in full and must not be taken again. */
  it('refuses a second full face of B after a mirror swap', async () => {
    // Arrange
    const a = tokenA206()
    const b = tokenB1365()
    redeemed('tok-206', a, { voucherId: OTHER_VOUCHER, amount: 100, exact: exactOf(b), nullifier: 'n-1365' })
    redeemed('tok-1365', b, { voucherId: SONG_VOUCHER, amount: 15, exact: exactOf(a), nullifier: 'n-206' })

    // Act
    const { check } = await checkPart({ voucherId: OTHER_VOUCHER, exact: exactOf(tokenB1365()), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(false)
  })

  /** After the mirror swap A's own ledger is exactly its genuine parts, so the honest 208 part is still taken. */
  it("still takes A's honest 208 part after a mirror swap", async () => {
    // Arrange
    const credits = [9, 5, 45]
    ;[137, 68, 616].forEach((sats, i) => {
      const t = coupon(SONG_VOUCHER, SONG_RATIO, sats)
      redeemed(`tok-${sats}`, t, { voucherId: SONG_VOUCHER, amount: credits[i], exact: exactOf(t), nullifier: `n-${sats}` })
    })
    const a = tokenA206()
    const b = tokenB1365()
    redeemed('tok-206', a, { voucherId: OTHER_VOUCHER, amount: 100, exact: exactOf(b), nullifier: 'n-1365' })
    redeemed('tok-1365', b, { voucherId: SONG_VOUCHER, amount: 15, exact: exactOf(a), nullifier: 'n-206' })

    // Act
    const { check } = await checkPart({ voucherId: SONG_VOUCHER, exact: lastPart(), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(true)
  })

  /** The one-sided case on staging: B's row is stamped A and nothing is stamped B. B was still redeemed in full. */
  it('refuses a second full face of B when only its row was misfiled', async () => {
    // Arrange
    songsGenuineParts()
    misfiledOtherCoupon()

    // Act
    const { check } = await checkPart({ voucherId: OTHER_VOUCHER, exact: exactOf(tokenB1365()), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(false)
  })
})

/**
 * Review of #145 (F4): the policy for one token seen twice, pinned.
 *
 * Two rows for the same received token count once. That is safe because a
 * token cannot be redeemed twice in the first place: the mint refuses a second
 * swap of the same proofs, and dm-poll drops a token whose fingerprint it has
 * already marked received. So a second row for one token is always a
 * bookkeeping copy, never a second redemption, and counting it would refuse an
 * honest later part.
 */
describe('one token, one redemption (#145 review)', () => {
  /** Two rows whose coupons are the same token count once. */
  it('counts the same token seen on two rows once', async () => {
    // Arrange: 95 booked in two genuine parts, then a copy of the second row.
    const first = coupon(SONG_VOUCHER, SONG_RATIO, 685)
    const second = coupon(SONG_VOUCHER, SONG_RATIO, 617)
    redeemed('tok-a', first, { voucherId: SONG_VOUCHER, amount: 49, exact: exactOf(first) })
    redeemed('tok-b', second, { voucherId: SONG_VOUCHER, amount: 45, exact: exactOf(second) })
    redeemed('tok-b-copy', second, { voucherId: SONG_VOUCHER, amount: 45, exact: exactOf(second) })

    // Act: 5 of the face is genuinely left, and a 5-unit part must fit.
    const { check } = await checkPart({
      voucherId: SONG_VOUCHER,
      exact: exactOf(coupon(SONG_VOUCHER, SONG_RATIO, 68)),
      signedFaceValue: FACE,
    })

    // Assert
    expect(check.allowed).toBe(true)
  })
})

/**
 * Review of #145 (snail 2): the claimed figure must read the same repaired
 * rows as the ceiling. Summing the raw rows, song's 208 part was filed at 11
 * (100 issued less 89 "claimed") while the ceiling credited it 16.
 */
describe('the claimed figure reads the repaired rows (#145 review)', () => {
  /** The 208 part's claim is filed at its full credit of 16, not capped by the misfiled row. */
  it("files song's 208 part at 16", async () => {
    // Arrange
    songsGenuineParts()
    misfiledOtherCoupon()
    const meta = {
      voucherId: SONG_VOUCHER,
      issuerId: STALL,
      faceValue: 16,
      faceUnit: 'EUR',
      validation: { signatureValid: true },
    }

    // Act
    const claim = await claimToFile(meta, STALL, lastPart())

    // Assert
    expect(claim?.amount).toBe(16)
  })

  /** On the record screens each voucher's claimed figure is its own genuine redemptions. */
  it('reports each voucher claimed as the redemptions its coupons name', async () => {
    // Arrange
    songsGenuineParts()
    misfiledOtherCoupon()

    // Act
    const rows = await repairedTransactions()
    const a = issuedVoucher(rows, SONG_VOUCHER, { now: 1, stallPubkey: STALL })
    const b = issuedVoucher(rows, OTHER_VOUCHER, { now: 1, stallPubkey: STALL })

    // Assert
    expect(a?.claimedMinor).toBe(74)
    expect(b?.claimedMinor).toBe(100)
  })
})

/**
 * Review of #145: a stamp's nullifier is the other redeem's, so it cannot say
 * two rows are one redemption. Only the row's own coupon can.
 */
describe('identity comes from the coupon, not the stamp (#145 review)', () => {
  /** Two genuine parts of one voucher that carry one copied nullifier are still two redemptions. */
  it('does not merge two distinct coupons that share a stamped nullifier', async () => {
    // Arrange: 94 of the face booked in two genuine parts, both stamped 'n-x'.
    const first = coupon(SONG_VOUCHER, SONG_RATIO, 685)
    const second = coupon(SONG_VOUCHER, SONG_RATIO, 617)
    redeemed('tok-a', first, { voucherId: SONG_VOUCHER, amount: 49, exact: exactOf(first), nullifier: 'n-x' })
    redeemed('tok-b', second, { voucherId: SONG_VOUCHER, amount: 45, exact: exactOf(second), nullifier: 'n-x' })

    // Act: 15 more would take it past the face.
    const { check } = await checkPart({ voucherId: SONG_VOUCHER, exact: lastPart(), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(false)
  })

  /** Of two copies of one redemption, the larger is the one counted. */
  it('keeps the larger of two copies of one token', async () => {
    // Arrange: the 616 part booked once small, then again at its real value.
    songsGenuineParts()
    const copy = coupon(SONG_VOUCHER, SONG_RATIO, 616)
    redeemed('tok-616-copy', copy, { voucherId: SONG_VOUCHER, amount: 1, exact: 1 })
    store.rows.push({ ...store.rows[store.rows.length - 1], id: 'received:tok-616-copy-big', amount: 45, exactValue: 60 } as unknown as TransactionRow)

    // Act: 60 counted for this token instead of 44.93 leaves no room for 15.17.
    const { check } = await checkPart({ voucherId: SONG_VOUCHER, exact: lastPart(), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(false)
  })
})

/**
 * Review of #145: the repair touches a stall's own issuances only. A
 * customer's rows carry the gateway's random voucher id. Re-filing them under
 * the coupon's voucher would make a customer who received a coupon, passed it
 * on and got it back refuse it, since the ceiling counts incoming rows only.
 */
describe("a customer's rows are left as they are (#145 review)", () => {
  /** With no issuance of the voucher on this device, an earlier receipt of it does not count against its return. */
  it('takes back a coupon a customer passed on, when it comes home again', async () => {
    // Arrange: a customer wallet, no issued rows. It received B's whole face once
    // (row under the gateway's random id), passed it on, and B comes back.
    store.rows = []
    const first = coupon(OTHER_VOUCHER, OTHER_RATIO, 1365)
    redeemed('tok-first', first, { voucherId: 'gateway-random-id', amount: 99, exact: exactOf(first) })

    // Act
    const { check } = await checkPart({ voucherId: OTHER_VOUCHER, exact: exactOf(coupon(OTHER_VOUCHER, OTHER_RATIO, 1365)), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(true)
  })
})

describe('a re-filed row keeps nothing of its stamp (#145 review)', () => {
  /**
   * The stamp's nullifier belonged to another redeem. Kept on a re-filed row it
   * could fold that row into an unrelated redemption of the same voucher whose
   * coupon is gone, and the ceiling would count one where there were two.
   */
  it("does not merge a re-filed row with another redemption through the stamp's nullifier", async () => {
    // Arrange: B's 137-sat coupon misfiled under A with nullifier 'n-x', and a
    // separate B redemption (coupon gone) worth 50 that carries 'n-x' too.
    const small = coupon(OTHER_VOUCHER, OTHER_RATIO, 137)
    redeemed('tok-b-small', small, { voucherId: SONG_VOUCHER, amount: 15, exact: 15.03, nullifier: 'n-x' })
    store.rows.push({
      id: 'received:tok-b-gone',
      type: 'received',
      timestamp: 1,
      amount: 50,
      exactValue: 50,
      unit: 'EUR',
      decimals: 2,
      voucherId: OTHER_VOUCHER,
      tokenId: 'tok-b-gone',
      attestationNullifier: 'n-x',
    } as unknown as TransactionRow)

    // Act: 10.04 + 50 are taken, so 49.82 more does not fit.
    const { check } = await checkPart({ voucherId: OTHER_VOUCHER, exact: exactOf(coupon(OTHER_VOUCHER, OTHER_RATIO, 680)), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(false)
  })

  /** Of two copies of one token, the larger counts whichever is read first. */
  it('keeps the larger copy when it is read first', async () => {
    // Arrange: the 616 part's large copy first, then its small copy.
    songsGenuineParts()
    const copy = coupon(SONG_VOUCHER, SONG_RATIO, 616)
    store.coupons.push({ token_id: 'tok-616-copy', token: copy, status: 'redeemed' } as unknown as VoucherRow)
    store.rows.splice(2, 0, {
      id: 'received:tok-616-big',
      type: 'received',
      timestamp: 1,
      amount: 45,
      exactValue: 60,
      unit: 'EUR',
      decimals: 2,
      voucherId: SONG_VOUCHER,
      tokenId: 'tok-616-copy',
    } as unknown as TransactionRow)
    redeemed('tok-616-copy', copy, { voucherId: SONG_VOUCHER, amount: 1, exact: 1 })

    // Act
    const { check } = await checkPart({ voucherId: SONG_VOUCHER, exact: lastPart(), signedFaceValue: FACE })

    // Assert
    expect(check.allowed).toBe(false)
  })
})
