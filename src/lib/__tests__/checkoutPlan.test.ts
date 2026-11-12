/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'
import type { VoucherRow } from '@imani/wallet-storage'

import { checkoutPlan, maxExpiryFor, MAX_CHECKOUT_PARTS } from '../checkoutPlan'
import { lockWindowProblem } from '../cashlinkLock'
import { pendingSendsKey } from '../inFlightMoney'
import { buildVoucherToken } from './voucherFixtures'

const NOW = 1_800_000_000
const DAY = 86_400
const X = NOW + 7 * DAY
const PAYER = 'ee'.repeat(32)
const STALL_KEY = schnorr.utils.randomSecretKey()
const STALL = bytesToHex(schnorr.getPublicKey(STALL_KEY))
const OTHER_KEY = schnorr.utils.randomSecretKey()

let n = 0
function row(face: number, opts: { sats?: number[]; expiresAt?: number; key?: Uint8Array; unit?: string; ratio?: number } = {}): VoucherRow {
  const key = opts.key ?? STALL_KEY
  const sats = opts.sats ?? [face]
  const ratio = opts.ratio ?? 1
  const built = buildVoucherToken(
    { voucherId: `v-${++n}`, faceValue: face, unit: opts.unit ?? 'EUR', issuanceRatio: ratio, expiresAt: opts.expiresAt ?? NOW + 90 * DAY },
    sats,
    {},
    key,
  )
  const total = sats.reduce((a, b) => a + b, 0)
  return {
    token_id: `t-${n}`,
    voucher_id: `v-${n}`,
    token: built.token,
    amount: total,
    token_amount: total,
    face_value: face,
    face_unit: opts.unit ?? 'EUR',
    issuer_id: built.voucher.issuerId,
    issuance_ratio: ratio,
    status: 'active',
    expires_at: opts.expiresAt ?? NOW + 90 * DAY,
    created_at: '',
    updated_at: '',
  } as VoucherRow
}

const plan = (rows: VoucherRow[], amount: number, x = X) =>
  checkoutPlan({ rows, payer: PAYER, stallId: STALL, unit: 'EUR', amount, x, nowS: NOW })

beforeEach(() => localStorage.clear())

describe('checkoutPlan (#402)', () => {
  it('excludes other stalls, other units, in-flight and too-soon coupons, with the reason', () => {
    // 256+128+64+32+16+4 = 500 of these 1000.
    const mine = row(1000, { sats: [256, 256, 128, 128, 64, 64, 32, 32, 16, 16, 4, 4] })
    const other = row(1000, { key: OTHER_KEY })
    const usd = row(1000, { unit: 'USD' })
    const busy = row(1000)
    const soon = row(1000, { expiresAt: X + DAY - 1 })
    localStorage.setItem(pendingSendsKey(PAYER), JSON.stringify([{ sendId: 's', tokenId: busy.token_id, amount: 1, unit: 'EUR', at: Date.now() }]))
    const out = plan([mine, other, usd, busy, soon], 500)
    expect(out.excluded.map((e) => [e.row, e.reason])).toEqual([
      [other, 'wrong_stall'],
      [usd, 'wrong_unit'],
      [busy, 'in_flight'],
      [soon, 'expires_too_soon'],
    ])
    expect(out.usable.map((c) => c.row)).toEqual([mine])
    expect(out.plan?.map((p) => p.amount)).toEqual([500])
  })

  it('excludes a coupon already locked or not lockable', () => {
    const whole = row(1000, { ratio: 2 })
    const out = plan([whole], 100)
    expect(out.excluded).toEqual([{ row: whole, reason: 'not_lockable' }])
    const broken = { ...row(1000), token: 'cashuBnope' }
    expect(plan([broken], 100).excluded[0].reason).toBe('not_lockable')
  })

  it('draws whole coupons then at most one split, at credited face value', () => {
    const a = row(1000)
    // The split part is carved from whole proofs: 256+128+64+32+16+4 = 500 of these 700.
    const b = row(700, { sats: [256, 128, 128, 64, 64, 32, 16, 8, 4] })
    const out = plan([a, b], 1500)
    expect(out.plan?.map((p) => [p.row, p.amount])).toEqual([
      [a, 1000],
      [b, 500],
    ])
    expect(out.plan?.filter((p) => p.amount !== p.faceValue)).toHaveLength(1)
  })

  it('does not offer a split no subset of the coupon\'s proofs makes (staging 2026-10-31)', () => {
    // One proof of 2000: a part of 1000 cannot be carved offline, so it is not a plan, and the
    // screen says so before Get code instead of failing after it.
    const one = row(2000, { sats: [2000] })
    expect(plan([one], 1000).obstacle).toMatchObject({ kind: 'not_splittable' })
    expect(plan([one], 2000).plan?.[0].amount).toBe(2000)
    // With a carvable coupon beside it, that one is split instead.
    // 512+256+128+64+32+8 = 1000 of these 1500.
    const many = row(1500, { sats: [512, 256, 256, 128, 128, 64, 64, 32, 32, 16, 8, 4] })
    const out = plan([one, many], 1000)
    expect(out.obstacle).toBeUndefined()
    expect(out.plan?.every((p) => p.amount === p.faceValue || p.row === many)).toBe(true)
  })

  it('credits the face value the sats back, not the row', () => {
    // 600 sats at ratio 1 against a signed face of 1000: credited 600.
    const short = row(1000, { sats: [600] })
    expect(plan([short], 600).plan?.[0]).toMatchObject({ faceValue: 600, amount: 600 })
    expect(plan([short], 700).obstacle).toEqual({ kind: 'insufficient_value', available: 600 })
  })

  it('names the obstacle', () => {
    expect(plan([row(1000)], 500, NOW + 60).obstacle).toEqual({ kind: 'expiry_window', problem: 'too_near' })
    expect(plan([row(999, { sats: [1], ratio: 999.5 })], 500).obstacle).toMatchObject({ kind: 'not_splittable' })
    const many = Array.from({ length: MAX_CHECKOUT_PARTS + 1 }, () => row(10))
    expect(plan(many, 10 * (MAX_CHECKOUT_PARTS + 1)).obstacle).toEqual({ kind: 'too_many_parts', parts: 21 })
    expect(plan(many, 200).plan).toHaveLength(20)
  })

  it('prefers, among plans of the same size, one with a splittable part', () => {
    // Both cover 1000 in one part. The soonest-expiring is a 1-sat coupon that cannot split.
    // (A fractional ratio: a whole one other than 1 is not lockable yet.)
    const stuck = row(999, { sats: [1], ratio: 999.5, expiresAt: NOW + 20 * DAY })
    const flexible = row(999)
    expect(plan([stuck], 999).plan?.[0].splittable).toBe(false)
    const out = plan([stuck, flexible], 999)
    expect(out.plan?.map((p) => p.row)).toEqual([flexible])
    expect(out.plan?.[0].splittable).toBe(true)
  })

  it('#405: a Shopify shop takes only splittable coupons, and names the rest', () => {
    const stuck = row(999, { sats: [1], ratio: 999.5 })
    const flexible = row(999)
    const out = checkoutPlan({ rows: [stuck, flexible], payer: PAYER, stallId: STALL, unit: 'EUR', amount: 999, x: X, nowS: NOW, requireSplittable: true })
    expect(out.usable.map((c) => c.row)).toEqual([flexible])
    expect(out.excluded).toEqual([{ row: stuck, reason: 'not_splittable_for_shop' }])
    expect(out.plan?.map((p) => p.row)).toEqual([flexible])
    // Without the option, both are usable.
    expect(plan([stuck, flexible], 999).usable).toHaveLength(2)
  })
})

describe('maxExpiryFor', () => {
  it('is the latest x every coupon passes, and passes lockWindowProblem', () => {
    const parts = [{ expiresAt: NOW + 90 * DAY }, { expiresAt: NOW + 10 * DAY }, { expiresAt: undefined }]
    const x = maxExpiryFor(parts, NOW)!
    expect(x).toBe(NOW + 9 * DAY - 300)
    for (const p of parts) {
      expect(lockWindowProblem(x, p.expiresAt, NOW)).toBeNull()
      expect(lockWindowProblem(x + 1, parts[1].expiresAt, NOW)).not.toBeNull()
    }
    expect(maxExpiryFor([], NOW)).toBe(NOW + 30 * DAY)
    expect(maxExpiryFor([{ expiresAt: NOW + DAY }], NOW)).toBeNull()
  })
})

describe('checkoutPlan: a split when carving is the only obstacle (#402)', () => {
  it('offers the amount with the one coupon to split marked, and still refuses when no split can make it', async () => {
    const W = await import('./cashlinkWorld')
    const w = W.world(NOW)
    // One 1024-sat proof at ratio 1 with its DLEQ: no subset makes 337, a split does.
    const token = W.tokenOf([w.mint.issue(W.bearerSecret({ nonce: 'splitnnn', issuanceRatio: 1, faceValue: 100_000, expiresAt: NOW + 90 * DAY }, 's0'), 1024)])
    const r = { token_id: 'split-row', voucher_id: 'v', token, amount: 1024, token_amount: 1024, face_value: 1024, face_unit: 'GBP', issuer_id: W.STALL, status: 'active', created_at: '', updated_at: '' } as VoucherRow
    const out = checkoutPlan({ rows: [r], payer: PAYER, stallId: W.STALL, unit: 'GBP', amount: 337, x: X, nowS: NOW })
    expect(out.obstacle).toBeUndefined()
    expect(out.plan).toHaveLength(1)
    expect(out.plan![0]).toMatchObject({ amount: 337, needsSplit: true })
    // A whole coupon needs no split.
    expect(checkoutPlan({ rows: [r], payer: PAYER, stallId: W.STALL, unit: 'GBP', amount: 1024, x: X, nowS: NOW }).plan![0].needsSplit).toBeUndefined()
  })

  it('a coupon locked to my own key is usable; one locked to another key is not', async () => {
    const W = await import('./cashlinkWorld')
    const { splitPartProposal } = await import('../cashlinkLock')
    const w = W.world(NOW)
    const bearer = W.bearerSecret({ nonce: 'selfnnnn', issuanceRatio: 1, faceValue: 100_000, expiresAt: NOW + 90 * DAY }, 'k0')
    const mine = W.signLocked(splitPartProposal(bearer, PAYER, 64, 'n1'))
    const theirs = W.signLocked(splitPartProposal(bearer, 'aa'.repeat(32), 64, 'n2'))
    const rowOf = (secret: string, id: string) => ({ token_id: id, voucher_id: 'v', token: W.tokenOf([w.mint.issue(secret, 64)]), amount: 64, token_amount: 64, face_value: 64, face_unit: 'GBP', issuer_id: W.STALL, status: 'active', created_at: '', updated_at: '' }) as VoucherRow
    const out = checkoutPlan({ rows: [rowOf(mine, 'm'), rowOf(theirs, 't')], payer: PAYER, stallId: W.STALL, unit: 'GBP', amount: 64, x: X, nowS: NOW })
    expect(out.usable.map((c) => c.row.token_id)).toEqual(['m'])
    expect(out.excluded).toEqual([expect.objectContaining({ reason: 'already_locked' })])
  })
})

describe('Use online shows the same holding as the balance (staging 2026-11-01: it showed more)', () => {
  // The balance (toMerchants) counts only `spendable` rows, at the row's own face_value. Use online
  // must never offer more than that: no row the balance leaves out, and no more than its face.
  // The cause on staging: a lock refused after its burn keeps the value as a swapped_to_sats row whose
  // token is the coupon proof, now spent. The balance left it out; Use online counted it.
  it('a row the balance leaves out (swapped to sats, fully redeemed) is not usable online', () => {
    const live = row(300)
    const swapped = { ...row(500), status: 'swapped_to_sats' } as VoucherRow
    const refused = { ...row(200), status: 'fully_redeemed' } as VoucherRow
    const out = plan([live, swapped, refused], 100)
    expect(out.usable.map((c) => c.row)).toEqual([live])
  })
})
