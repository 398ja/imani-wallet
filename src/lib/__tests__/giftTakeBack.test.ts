/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * #410 G14: the BUYER gets an unclaimed gift back. A gifting-site gift is minted already locked
 * (to the recipient's key, or to the email link's key) with `refund = [R]` and `locktime = x`, and
 * nothing is left at the refund relay. So after `x` the buyer's own key `R` must be able to take the
 * value back, by itself, from any state the gift can be in.
 *
 * Against `cashlinkWorld`: a mint that enforces NUT-11 (only the lock key before `x`; the lock key
 * OR the refund key after it), signs with real keys, records witnesses and answers NUT-09, and a
 * gateway that implements the re-sign rules. Nothing here is mocked between the buyer and the value.
 *
 * What "regained access" means, checked every time: the coupon is back in the buyer's wallet
 * (`keep`), UNLOCKED (spendable like any coupon), worth the whole gift, re-signed for the REFUND
 * key's spend, and the locked proofs are spent.
 */
vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const { claimLockedGift } = await import('../cashlinkFlow')
const { linkLockProposal, readLinkLock, xOnlyPub } = await import('../cashlinkLock')
const { secretToText } = await import('../giftLink')
const { parseVoucherToken, tokenProofs } = await import('../voucherToken')
const { returnStateOf, settleIncoming, takeBackLockedGift } = await import('../lockedGifts')
const { bearerSecret, signLocked, tokenOf, world, at, MINT_URL } = await import('./cashlinkWorld')

const NOW = 1_800_000_000
const X = NOW + 30 * 86_400
const LOCK = hexToBytes('33'.repeat(32)) // the recipient's key (handle) or the link key (email)
const R = hexToBytes('44'.repeat(32)) // the buyer's refund key
const STRANGER = hexToBytes('55'.repeat(32))
const RECIPIENT_WALLET = 'c3'.repeat(32)

let w: ReturnType<typeof world>

/** A gift as the Purchase Issuer's mint makes it: every proof locked, refund = R, locktime x. */
function giftMinted(amounts = [64], x = X): string {
  const proofs = amounts.map((a, n) =>
    w.mint.issue(
      signLocked(linkLockProposal({ giftSecret: bearerSecret({}, `g${n}`), linkPub: xOnlyPub(LOCK), refundPub: xOnlyPub(R), x, maxSats: a, nonce: `n${n}` })),
      a,
    ),
  )
  return tokenOf(proofs)
}

const keptSats = () => w.kept.reduce((n, k) => n + (k.sats ?? parseVoucherToken(k.token).tokenAmount), 0)
const spent = (token: string) => w.mint.states(MINT_URL, tokenProofs(token).map((p) => p.secret))

/** Everything "the buyer has the voucher back" means, in one place. */
function expectBackInBuyersWallet(sats: number) {
  expect(keptSats()).toBe(sats)
  for (const k of w.kept) {
    expect(k.why).toBe('returned')
    const v = parseVoucherToken(k.token)
    // Unlocked: no lock key, no locktime, no refund tag. The buyer can spend it like any coupon.
    expect(v.voucher.lockKey).toBeUndefined()
    for (const p of tokenProofs(k.token)) expect(readLinkLock(p.secret)).toBeNull()
  }
  // Re-signed for the refund key's spend, never the lock key's.
  expect([...w.gateway.resigns.values()].every((r) => r.caller === 'refund')).toBe(true)
}

beforeEach(() => {
  localStorage.clear()
  w = world(NOW)
})

describe('an unclaimed gift comes back to the buyer after x', () => {
  it('the whole gift, as an unlocked coupon in the buyer’s wallet', async () => {
    const gift = giftMinted([64])
    at(w, X + 1)
    expect((await takeBackLockedGift(w.ports, R, gift)).kind).toBe('returned')
    expectBackInBuyersWallet(64)
    expect(await spent(gift)).toEqual(['SPENT'])
  })

  it('a gift of several proofs comes back whole, every proof', async () => {
    const gift = giftMinted([64, 32, 4])
    at(w, X + 1)
    expect((await takeBackLockedGift(w.ports, R, gift)).kind).toBe('returned')
    expectBackInBuyersWallet(100)
    expect(await spent(gift)).toEqual(['SPENT', 'SPENT', 'SPENT'])
  })

  it('the coupon that came back keeps the gift’s terms (same stall, unit, face value)', async () => {
    const gift = giftMinted([64])
    const before = parseVoucherToken(gift).voucher
    at(w, X + 1)
    await takeBackLockedGift(w.ports, R, gift)
    const after = parseVoucherToken(w.kept[0].token).voucher
    expect({ issuer: after.issuerId, unit: after.unit, face: after.faceValue, id: after.voucherId, expires: after.expiresAt }).toEqual({
      issuer: before.issuerId,
      unit: before.unit,
      face: before.faceValue,
      id: before.voucherId,
      // NOT renewed: a gift taken back keeps the coupon's own expiry (the stall's signed term).
      expires: before.expiresAt,
    })
    expect(after.expiresAt).toBeDefined()
  })

  it('long after x (weeks), it still comes back', async () => {
    const gift = giftMinted([64])
    at(w, X + 21 * 86_400)
    expect((await takeBackLockedGift(w.ports, R, gift)).kind).toBe('returned')
    expectBackInBuyersWallet(64)
  })
})

describe('never before x, never by anyone else', () => {
  it('before x the buyer cannot take it: nothing moves, the recipient can still claim', async () => {
    const gift = giftMinted([64])
    at(w, X - 60)
    expect((await takeBackLockedGift(w.ports, R, gift)).kind).toBe('waiting')
    expect(w.mint.log.swaps).toHaveLength(0)
    expect(await spent(gift)).toEqual(['UNSPENT'])
  })

  it('the mint itself refuses the refund key before x (a buyer’s clock ahead does not help)', async () => {
    const gift = giftMinted([64])
    // The buyer's device thinks x has passed; the mint does not.
    w.clock.now = X + 120
    w.mint.now = X - 60
    const out = await takeBackLockedGift(w.ports, R, gift)
    expect(out.kind).not.toBe('returned')
    expect(w.kept).toHaveLength(0)
    expect(await spent(gift)).toEqual(['UNSPENT'])
    // Once the mint's clock passes x too, the next run takes it back.
    w.mint.now = X + 120
    expect((await takeBackLockedGift(w.ports, R, gift)).kind).toBe('returned')
    expectBackInBuyersWallet(64)
  })

  it('a key that is not the refund key gets nothing, even after x', async () => {
    const gift = giftMinted([64])
    at(w, X + 1)
    expect((await takeBackLockedGift(w.ports, STRANGER, gift)).kind).toBe('unknown')
    expect(w.mint.log.swaps).toHaveLength(0)
    expect(await spent(gift)).toEqual(['UNSPENT'])
  })
})

describe('when the recipient got there first', () => {
  it('claimed before x: the buyer gets nothing back, and is told it was claimed', async () => {
    const gift = giftMinted([64])
    await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT_WALLET, linkSecret: LOCK, k: secretToText(LOCK), lockedTokens: [{ token: gift, sentAt: NOW }] })
    w.kept.length = 0
    at(w, X + 1)
    expect((await takeBackLockedGift(w.ports, R, gift)).kind).toBe('claimed')
    expect(w.kept).toHaveLength(0)
  })

  it('a late claim after x but before the buyer acts wins (G14: the value does not move by itself)', async () => {
    const gift = giftMinted([64])
    at(w, X + 3600)
    // The recipient's wallet (a handle gift) claims after x: the lock key still spends it.
    expect(await settleIncoming(w.ports, RECIPIENT_WALLET, gift, () => Uint8Array.from(LOCK))).toBe('claimed')
    w.kept.length = 0
    expect((await takeBackLockedGift(w.ports, R, gift)).kind).toBe('claimed')
    expect(w.kept).toHaveLength(0)
  })

  it('once the buyer has taken it back, the recipient cannot claim it', async () => {
    const gift = giftMinted([64])
    at(w, X + 1)
    await takeBackLockedGift(w.ports, R, gift)
    const buyerKept = w.kept.length
    expect(await settleIncoming(w.ports, RECIPIENT_WALLET, gift, () => Uint8Array.from(LOCK))).toBe('gone')
    expect(w.kept).toHaveLength(buyerKept)
  })
})

describe('a take-back that is interrupted finishes on the next run, never twice', () => {
  it('a lost reply from the mint: the next run recovers the same outputs (NUT-09), keeps once', async () => {
    const gift = giftMinted([64])
    at(w, X + 1)
    w.mint.loseNextReply = true
    const first = await takeBackLockedGift(w.ports, R, gift)
    expect(first.kind).not.toBe('returned')
    expect(w.kept).toHaveLength(0)
    expect(await spent(gift)).toEqual(['SPENT'])
    expect((await takeBackLockedGift(w.ports, R, gift)).kind).toBe('returned')
    expectBackInBuyersWallet(64)
  })

  it('the mint unreachable: nothing changes, the next run takes it back', async () => {
    const gift = giftMinted([64])
    at(w, X + 1)
    w.mint.down = true
    expect((await takeBackLockedGift(w.ports, R, gift)).kind).not.toBe('returned')
    expect(w.kept).toHaveLength(0)
    w.mint.down = false
    expect((await takeBackLockedGift(w.ports, R, gift)).kind).toBe('returned')
    expectBackInBuyersWallet(64)
  })

  it('the gateway unreachable after the swap: the sats are safe, the next run re-forms the coupon', async () => {
    const gift = giftMinted([64])
    at(w, X + 1)
    w.gateway.down = true
    const first = await takeBackLockedGift(w.ports, R, gift)
    expect(first.kind).not.toBe('returned')
    w.gateway.down = false
    expect((await takeBackLockedGift(w.ports, R, gift)).kind).toBe('returned')
    expectBackInBuyersWallet(64)
  })

  it('the mint rotated its keyset since the gift was minted: it still comes back', async () => {
    const gift = giftMinted([64])
    w.mint.rotate()
    at(w, X + 1)
    expect((await takeBackLockedGift(w.ports, R, gift)).kind).toBe('returned')
    expectBackInBuyersWallet(64)
  })

  it('running it again after it came back keeps nothing twice', async () => {
    const gift = giftMinted([64, 32])
    at(w, X + 1)
    await takeBackLockedGift(w.ports, R, gift)
    const n = w.kept.length
    for (let i = 0; i < 3; i++) expect((await takeBackLockedGift(w.ports, R, gift)).kind).toBe('returned')
    expect(w.kept).toHaveLength(n)
    expectBackInBuyersWallet(96)
  })
})

describe('what the return page shows', () => {
  it('waiting before x, ready after, claimed when spent, unknown when the mint cannot say', () => {
    expect(returnStateOf(['UNSPENT'], X, (X - 1) * 1000)).toBe('waiting')
    expect(returnStateOf(['UNSPENT'], X, X * 1000)).toBe('ready')
    expect(returnStateOf(['UNSPENT', 'UNSPENT'], X, (X + 9) * 1000)).toBe('ready')
    expect(returnStateOf(['SPENT'], X, (X + 9) * 1000)).toBe('claimed')
    expect(returnStateOf(['UNKNOWN'], X, (X + 9) * 1000)).toBe('unknown')
    expect(returnStateOf(['PENDING'], X, (X + 9) * 1000)).toBe('unknown')
    expect(returnStateOf([], X, (X + 9) * 1000)).toBe('unknown')
  })
})
