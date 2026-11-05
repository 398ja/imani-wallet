/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * Staging, 2026-11-05 (v0.55.2): a Cashlink of THREE coupons (vouchers b4fc..., 210c..., e79d...,
 * 14 proofs) could be neither claimed nor taken back. The arm locked every proof into ONE token, and
 * `parseVoucherToken` refuses a token mixing vouchers, so `giftCandidates` dropped the link's only
 * gift: the claimer and the issuer both found nothing. A one-coupon link (the second Cashlink) was
 * fine. Pinned here:
 *
 * - the arm puts one locked token per voucher on the link, every one parseable;
 * - a claim and a take-back recover every proof of a multi-coupon link;
 * - a link already armed the old way (one mixed token) is read per voucher, so it recovers too;
 * - a take-back is kept with the link's bundle id, marked `takenBack` (its History row).
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const { armGift, claimLockedGift, settleLockedGift, cashlinkBundleId, wrapForLink, linkWrapBytes, LINK_WRAP_BUDGET } = await import('../cashlinkFlow')
const { linkPubOf, secretToText, giftCandidates, giftTokensFrom } = await import('../giftLink')
const { parseVoucherToken, splitTokenByVoucher, tokenProofs } = await import('../voucherToken')
const { encodePlainTokenV4 } = await import('../plainToken')
const { MINT_URL, bearerSecret, tokenOf, world, at } = await import('./cashlinkWorld')
const { combineReturns } = await import('../giftLinks')

type World = ReturnType<typeof world>

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const LINK = hexToBytes('11'.repeat(32))
const REFUND = hexToBytes('22'.repeat(32))
const RECIPIENT = 'c3'.repeat(32)
const VOUCHERS = ['vA', 'vB', 'vC']

let w: World

function threeCoupons() {
  return VOUCHERS.map((v, i) => ({
    token: tokenOf([1, 2, 4, 8].slice(0, i + 2).map((a, n) => w.mint.issue(bearerSecret({ voucherId: v } as never, `${v}${n}`), a))),
    sentAt: NOW,
  }))
}

async function arm() {
  return armGift({ ports: w.ports, linkSecret: LINK, refundSecret: REFUND, x: X, gifts: threeCoupons(), merchant: false, onArming: async () => {}, onLocked: async () => {}, knownLocks: new Map() } as never)
}

beforeEach(() => {
  w = world(NOW)
})

describe('a Cashlink of several coupons', () => {
  it('is put on the link as one parseable locked token per voucher', async () => {
    const out = await arm()
    expect(out.kind).toBe('armed')
    expect(w.wraps).toHaveLength(3)
    expect(w.wraps.map((t) => parseVoucherToken(t).voucher.voucherId).sort()).toEqual(VOUCHERS)
    expect(giftCandidates(w.wraps.map((token) => ({ token, sentAt: NOW })), linkPubOf(LINK))).toHaveLength(3)
  })

  it('is claimed whole: every proof of every coupon', async () => {
    await arm()
    const out = await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LINK, k: secretToText(LINK), lockedTokens: w.wraps.map((token) => ({ token, sentAt: NOW })) })
    expect(out.kind).toBe('ok')
    expect(w.kept.filter((k) => k.why === 'claimed')).toHaveLength(2 + 3 + 4)
  })

  it('is taken back whole, each coupon kept as a "taken back" row of the link bundle', async () => {
    await arm()
    const outcomes = []
    for (const lockedToken of w.wraps) {
      outcomes.push(await settleLockedGift({ ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken, takeBackNow: true, onReturning: async () => {} }))
    }
    expect(combineReturns(outcomes).kind).toBe('returned')
    const back = w.kept.filter((k) => k.why === 'returned')
    expect(back).toHaveLength(9)
    expect(back.every((k) => k.takenBack === true && k.bundleId === cashlinkBundleId(linkPubOf(LINK)))).toBe(true)
  })
})

describe('a link armed the old way, one token mixing coupons (the owner\'s stuck Cashlink 1)', () => {
  async function mixedOnLink(): Promise<string> {
    await arm()
    const proofs = w.wraps.flatMap((t) => tokenProofs(t))
    return encodePlainTokenV4(MINT_URL, 'sat', proofs)
  }

  it('was refused by the reader before the fix (the reproduction)', async () => {
    const mixed = await mixedOnLink()
    expect(() => parseVoucherToken(mixed)).toThrow(/more than one voucher/)
  })

  it('is read from its wrap as one token per voucher, and taken back after x by the refund way', async () => {
    const mixed = await mixedOnLink()
    const found = await giftTokensFrom(LINK, [wrapForLink(LINK, mixed, 'a'.repeat(64)) as never])
    expect(found).toHaveLength(3)
    expect(splitTokenByVoucher(mixed)).toHaveLength(3)
    const locked = giftCandidates(found, linkPubOf(LINK))
    expect(locked).toHaveLength(3)
    at(w, X + 60)
    const outcomes = []
    for (const { token } of locked) outcomes.push(await settleLockedGift({ ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken: token, onReturning: async () => {} }))
    expect(combineReturns(outcomes).kind).toBe('returned')
    expect(w.kept.filter((k) => k.why === 'returned')).toHaveLength(9)
  })

  it('is claimable before x', async () => {
    const mixed = await mixedOnLink()
    const found = await giftTokensFrom(LINK, [wrapForLink(LINK, mixed) as never])
    const out = await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LINK, k: secretToText(LINK), lockedTokens: giftCandidates(found, linkPubOf(LINK)) })
    expect(out.kind).toBe('ok')
    expect(w.kept.filter((k) => k.why === 'claimed')).toHaveLength(9)
  })
})

describe('a large Cashlink (3 coupons x 30 proofs): every wrap under the relay limit', { timeout: 60_000 }, () => {
  function big() {
    return VOUCHERS.map((v) => ({
      token: tokenOf(Array.from({ length: 30 }, (_, n) => w.mint.issue(bearerSecret({ voucherId: v } as never, `${v}${n}`), 2 ** (n % 8)))),
      sentAt: NOW,
    }))
  }
  const armBig = () => armGift({ ports: w.ports, linkSecret: LINK, refundSecret: REFUND, x: X, gifts: big(), merchant: false, onArming: async () => {}, onLocked: async () => {}, knownLocks: new Map() } as never)

  it('goes on the link in several self-contained wraps, each measured on the real event', async () => {
    expect((await armBig()).kind).toBe('armed')
    expect(w.wraps.length).toBeGreaterThan(3)
    for (const t of w.wraps) {
      expect(linkWrapBytes(LINK, t)).toBeLessThanOrEqual(LINK_WRAP_BUDGET)
      expect(linkWrapBytes(LINK, t)).toBeLessThanOrEqual(65_536)
      expect(() => parseVoucherToken(t)).not.toThrow()
    }
    expect(w.wraps.flatMap((t) => tokenProofs(t))).toHaveLength(90)
  })

  it('is claimed and taken back across every wrap', async () => {
    await armBig()
    const parts = [...w.wraps]
    const claimed = await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LINK, k: secretToText(LINK), lockedTokens: parts.slice(0, 2).map((token) => ({ token, sentAt: NOW })) })
    expect(claimed.kind).toBe('ok')
    const outcomes = []
    for (const lockedToken of parts.slice(2)) outcomes.push(await settleLockedGift({ ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken, takeBackNow: true, onReturning: async () => {} }))
    expect(combineReturns(outcomes).kind).toBe('returned')
    const n = (why: string) => w.kept.filter((k) => k.why === why).length
    expect(n('claimed') + n('returned')).toBe(90)
  })

  it('a part not confirmed on the link leaves the arm for the next run, which re-sends it', async () => {
    let refused = 0
    const deliver = w.ports.deliver
    w.ports.deliver = async (s, t) => (w.wraps.length === 1 && refused++ === 0 ? false : deliver(s, t))
    expect((await armBig()).kind).toBe('arming')
    w.ports.deliver = deliver
    const again = await armGift({ ports: w.ports, linkSecret: LINK, refundSecret: REFUND, x: X, gifts: big(), merchant: false, resuming: true, onArming: async () => {}, onLocked: async () => {}, knownLocks: new Map() } as never)
    expect(again.kind).toBe('armed')
    expect(new Set(w.wraps.flatMap((t) => tokenProofs(t).map((p) => p.secret))).size).toBe(90)
  })
})

describe('combineReturns', () => {
  it('reads a link as taken back only when nothing is left unfinished', () => {
    expect(combineReturns([{ kind: 'returned' }, { kind: 'claimed' }]).kind).toBe('returned')
    expect(combineReturns([{ kind: 'claimed' }, { kind: 'claimed' }]).kind).toBe('claimed')
    expect(combineReturns([{ kind: 'returned' }, { kind: 'waiting' }]).kind).toBe('returning')
    expect(combineReturns([{ kind: 'waiting' }, { kind: 'waiting' }]).kind).toBe('waiting')
    expect(combineReturns([{ kind: 'returned' }, { kind: 'unknown', why: 'x' }]).kind).toBe('unknown')
  })
})
