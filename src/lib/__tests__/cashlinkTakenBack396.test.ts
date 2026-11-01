/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * imani-wallet#396: on staging, "Take it back" on an ARMED Cashlink showed "Taken back" while every
 * proof was still UNSPENT at the mint. The row is marked `returning` BEFORE the swap is sent (so a
 * page that dies finishes it on the next run), and History read `returning` as "Taken back". If the
 * swap then did not happen (the mint refused it for now, or the page died), the sender was told the
 * value was back when it was still on the link.
 *
 * The rule now: "Taken back" only when the link is `reclaimed`, which is written after the mint
 * swap and the re-form. While it is only `returning`, History says "Coming back".
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const { giftStatusLabel } = await import('../transactions')
const { armGift, settleLockedGift, RESIGN_PATH } = await import('../cashlinkFlow')
const { tokenProofs } = await import('../voucherToken')
const { bearerSecret, tokenOf, world, MINT_URL } = await import('./cashlinkWorld')

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const LINK = hexToBytes('11'.repeat(32))
const REFUND = hexToBytes('22'.repeat(32))

describe('#396 History never says "Taken back" before the mint swap is confirmed', () => {
  it('a link only marked returning (the take-back has started) reads "Coming back", not "Taken back"', () => {
    // RED on v0.39.3: this read "Taken back".
    expect(giftStatusLabel({ status: 'outstanding', x: X, arm: { s: 'returning' } }, NOW * 1000)).toBe('Coming back')
  })

  it('a reclaimed link (swap done, voucher back) reads "Taken back"', () => {
    expect(giftStatusLabel({ status: 'reclaimed', x: X, arm: { s: 'returning' } }, NOW * 1000)).toBe('Taken back')
  })

  it('Take it back on an armed link whose swap the mint does not sign: proofs UNSPENT, and the row is not "Taken back"', async () => {
    // The staging Q4 case: an armed gift, "Take it back" before x, and the mint swap does not happen.
    const w = world(NOW)
    const gift = { token: tokenOf([w.mint.issue(bearerSecret(), 64)]), sentAt: NOW }
    const locks = new Map<string, string>()
    const armed = await armGift({
      ports: w.ports, linkSecret: LINK, refundSecret: REFUND, x: X, gifts: [gift], merchant: false,
      onArming: async () => {}, onLocked: async (g: string, s: string) => void locks.set(g, s), knownLocks: locks,
    })
    expect(armed.kind).toBe('armed')
    const lockedToken = w.wraps[w.wraps.length - 1]
    // The mint answers its state (UNSPENT) but does not sign the take-back swap this time.
    const swap = w.mint.swap.bind(w.mint)
    w.mint.swap = async () => ({ kind: 'refused', code: 20000 }) as never
    let arm: { s: 'armed' | 'returning' } = { s: 'armed' }
    const out = await settleLockedGift({
      ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken, takeBackNow: true,
      onReturning: async () => void (arm = { s: 'returning' }),
    })
    w.mint.swap = swap
    expect(out.kind).not.toBe('returned')
    // The take-back had started: the row was marked returning before the swap went out.
    expect(arm.s).toBe('returning')
    // The value is still on the link...
    expect(await w.mint.states(MINT_URL, tokenProofs(lockedToken).map((p) => p.secret))).toEqual(['UNSPENT'])
    expect(w.kept).toHaveLength(0)
    // ...so History must not say it came back.
    expect(giftStatusLabel({ status: 'outstanding', x: X, arm }, NOW * 1000)).not.toBe('Taken back')
  })

  it('Take it back on an armed link before x: the mint swap happens and the voucher is kept', async () => {
    const w = world(NOW)
    const gift = { token: tokenOf([w.mint.issue(bearerSecret(), 64)]), sentAt: NOW }
    const locks = new Map<string, string>()
    await armGift({
      ports: w.ports, linkSecret: LINK, refundSecret: REFUND, x: X, gifts: [gift], merchant: false,
      onArming: async () => {}, onLocked: async (g: string, s: string) => void locks.set(g, s), knownLocks: locks,
    })
    const lockedToken = w.wraps[w.wraps.length - 1]
    const out = await settleLockedGift({ ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken, takeBackNow: true, onReturning: async () => {} })
    expect(out.kind).toBe('returned')
    expect(await w.mint.states(MINT_URL, tokenProofs(lockedToken).map((p) => p.secret))).toEqual(['SPENT'])
    expect(w.kept).toHaveLength(1)
  })

  it('past the stored x but before the lock\u2019s real locktime: nothing is reclaimed yet; after the locktime it comes back', async () => {
    // The CL-EXP case with arming on: the mint refuses the refund until the lock's own locktime.
    const w = world(NOW)
    const gift = { token: tokenOf([w.mint.issue(bearerSecret(), 64)]), sentAt: NOW }
    const locks = new Map<string, string>()
    await armGift({
      ports: w.ports, linkSecret: LINK, refundSecret: REFUND, x: X, gifts: [gift], merchant: false,
      onArming: async () => {}, onLocked: async (g: string, s: string) => void locks.set(g, s), knownLocks: locks,
    })
    const lockedToken = w.wraps[w.wraps.length - 1]
    const ctx = { ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken, onReturning: async () => {} }
    expect((await settleLockedGift(ctx)).kind).toBe('waiting')
    expect(w.kept).toHaveLength(0)
    w.mint.now = X + 61
    w.ports.now = () => (X + 61) * 1000
    expect((await settleLockedGift(ctx)).kind).toBe('returned')
    expect(await w.mint.states(MINT_URL, tokenProofs(lockedToken).map((p) => p.secret))).toEqual(['SPENT'])
    expect(w.kept).toHaveLength(1)
  })
})

describe('#396 a rate-limited answer (429) is "not now", never a refusal', () => {
  // gateway-customer limits the Cashlink routes to 20 requests a minute per key. On the local gate
  // with the relay on, the take-back re-sign hit it, and the wallet read the 429 as a definite
  // refusal: the value was kept as plain sats instead of the voucher coming back as a voucher.
  const LIMITED = { status: 429, body: null }

  async function armed(w: ReturnType<typeof world>) {
    const gift = { token: tokenOf([w.mint.issue(bearerSecret(), 64)]), sentAt: NOW }
    const locks = new Map<string, string>()
    await armGift({
      ports: w.ports, linkSecret: LINK, refundSecret: REFUND, x: X, gifts: [gift], merchant: false,
      onArming: async () => {}, onLocked: async (g: string, s: string) => void locks.set(g, s), knownLocks: locks,
    })
    return w.wraps[w.wraps.length - 1]
  }

  it('Take it back, re-sign answers 429 once: the wallet waits, asks again, and the VOUCHER comes back (not sats)', async () => {
    const w = world(NOW)
    const lockedToken = await armed(w)
    w.gateway.override.set(RESIGN_PATH, LIMITED)
    const out = await settleLockedGift({ ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken, takeBackNow: true, onReturning: async () => {} })
    expect(out.kind).toBe('returned')
    expect(w.kept).toHaveLength(1)
    // RED on v0.39.3: the 429 was read as a refusal and the value kept as sats.
    expect(w.kept[0].satsToken).toBeUndefined()
  })

  it('Take it back, re-sign rate limited on every try: it stays on its way back (pending), nothing kept as sats, and the next run finishes', async () => {
    const w = world(NOW)
    const lockedToken = await armed(w)
    const call = w.gateway.call.bind(w.gateway)
    let limited = true
    w.gateway.call = async (m, p, b, s) => (limited && p === RESIGN_PATH ? LIMITED : call(m, p, b, s))
    const ctx = { ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken, takeBackNow: true, onReturning: async () => {} }
    expect((await settleLockedGift(ctx)).kind).toBe('returning')
    expect(w.kept).toHaveLength(0)
    limited = false
    expect((await settleLockedGift(ctx)).kind).toBe('returned')
    expect(w.kept).toHaveLength(1)
    expect(w.kept[0].satsToken).toBeUndefined()
  })
})
