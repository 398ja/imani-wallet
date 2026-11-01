/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools'

/**
 * #402: splitting a coupon so a checkout code can make an amount its proofs cannot (the €10 → €3.37
 * case), against `cashlinkWorld`: a mint that signs and enforces NUT-11, and the gateway's
 * `/vouchers/bearer-split` rules. Every test that moves value ends by counting where it is.
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const { planSplit, canSplit } = await import('../voucherSplitPlan')
const split = await import('../voucherSplit')
const { carveProofs } = await import('../checkoutCarve')
const { parseVoucherToken, tokenProofs, creditableFaceValue } = await import('../voucherToken')
const { isSelfLocked, xOnlyPub } = await import('../cashlinkLock')
const { moneyInFlight } = await import('../inFlightMoney')
const W = await import('./cashlinkWorld')

const NOW = 1_800_000_000
const ID = hexToBytes('33'.repeat(32))
const ME = getPublicKey(ID)

type World = ReturnType<typeof W.world>
let w: World
let rows: Map<string, string>
let commits: number
let ports: import('../voucherSplit').SplitPorts

/** A €-coupon at ratio 1 (1 sat = 1 cent), so every power of two of sats is a whole cent. */
function coupon(amounts: number[], nonce: string) {
  const proofs = amounts.map((a, n) => w.mint.issue(W.bearerSecret({ nonce: nonce.padEnd(8, 'n'), issuanceRatio: 1, faceValue: 100_000 }, `${nonce}${n}`), a))
  const token = W.tokenOf(proofs)
  rows.set(`row-${nonce}`, token)
  return { tokenId: `row-${nonce}`, token }
}

const sats = (token: string) => tokenProofs(token).reduce((n, p) => n + p.amount, 0)
const face = (token: string) => creditableFaceValue(parseVoucherToken(token)).faceValue
/** Every sat of value this wallet holds: coupon rows, plus sats kept. */
const held = () => [...rows.values()].reduce((n, t) => n + sats(t), 0) + w.kept.reduce((n, k) => n + (k.sats ?? 0), 0)

beforeEach(() => {
  w = W.world(NOW)
  rows = new Map()
  commits = 0
  localStorage.clear()
  ports = {
    ...w.ports,
    identitySecret: () => Uint8Array.from(ID),
    commit: async (source, remainder, parts) => {
      commits += 1
      const partIds = parts.map((_, n) => `split-${n}-${parts[n].slice(-12)}`)
      parts.forEach((t, n) => rows.set(partIds[n], t))
      if (remainder) rows.set(source, remainder)
      else rows.delete(source)
      return { partIds, remainderId: remainder ? source : null }
    },
    keep: async (row) => {
      w.kept.push(row)
    },
  }
})

describe('planning a split', () => {
  it('€10.24 as one proof: €3.37 is the amount part plus change, whole cents, under 20 parts', async () => {
    const c = coupon([1024], 'a')
    expect(carveProofs(c.token, 337)).toBeNull()
    const plan = planSplit(c.token, 337)!
    expect(plan).not.toBeNull()
    expect(plan.carveAmount).toBe(0)
    expect(plan.need).toBe(337)
    expect(plan.sats.slice(0, plan.needCount).reduce((n, s) => n + s, 0)).toBe(337)
    expect(plan.sats.reduce((n, s) => n + s, 0)).toBe(1024)
    expect(plan.sats.length).toBeLessThanOrEqual(20)
    expect(plan.remainder).toBeNull()
  })

  it('keeps whole proofs where it can and splits only what is needed', async () => {
    const c = coupon([512, 256, 128], 'b')
    const plan = planSplit(c.token, 600)!
    // 512 kept whole, 88 split out of the 128 (the largest proof that can make the rest).
    expect(plan.carveAmount + plan.need).toBe(600)
    expect(plan.carveAmount).toBeGreaterThan(0)
    expect(carveProofs(plan.remainder!, plan.carveAmount)).not.toBeNull()
  })

  it('refuses where no sat count rounds to the amount (ratio 3: 1 sat is 3 c, 5 c cannot be made)', async () => {
    const proofs = [w.mint.issue(W.bearerSecret({ nonce: 'cnnnnnnn', issuanceRatio: 3, faceValue: 100_000 }, 'c0'), 64)]
    expect(canSplit(W.tokenOf(proofs), 5)).toBe(false)
    expect(canSplit(W.tokenOf(proofs), 6)).toBe(true)
  })

  it('splits a coupon issued at a real day rate (staging: 1 sat = 0.0694 c), valued as the store rounds it', async () => {
    // bart's €10 coupon on staging: 8192+4096+2048+64+8+4+1 sats at ratio 0.06938…; no power of two
    // of sats is a whole cent, so the first version refused every amount (2026-11-01).
    const ratio = 0.06938180808991883
    const amounts = [8192, 4096, 2048, 64, 8, 4, 1]
    const proofs = amounts.map((a, n) => w.mint.issue(W.bearerSecret({ nonce: 'rnnnnnnn', issuanceRatio: ratio, faceValue: 1000 }, `r${n}`), a))
    const token = W.tokenOf(proofs)
    for (const amount of [337, 125, 199, 500, 1]) {
      const plan = planSplit(token, amount)
      expect(plan, `€${amount / 100}`).not.toBeNull()
      const needSats = plan!.sats.slice(0, plan!.needCount).reduce((n, s) => n + s, 0)
      // What the code store will credit the part: round(sats × ratio), plus whatever is carved whole.
      expect(Math.round(needSats * ratio) + plan!.carveAmount).toBe(amount)
      expect(plan!.sats.reduce((n, s) => n + s, 0)).toBe(plan!.proof.amount)
      expect(plan!.sats.length).toBeLessThanOrEqual(20)
    }
  })

  it('refuses a proof without its amount proof (the route would refuse it after the burn)', async () => {
    const p = w.mint.issue(W.bearerSecret({ nonce: 'dnnnnnnn', issuanceRatio: 1, faceValue: 100_000 }, 'd0'), 1024)
    const bare = { amount: p.amount, id: p.id, secret: p.secret, C: p.C }
    expect(canSplit(W.tokenOf([bare]), 337)).toBe(false)
  })
})

describe('splitting', () => {
  it('happy path: €10.24 → €3.37 + €6.87, parts locked to me, rows written, nothing lost', async () => {
    const c = coupon([1024], 'a')
    const before = held()
    const out = await split.splitVoucher(ports, ME, { tokenId: c.tokenId, token: c.token, amount: 337 })
    expect(out.kind).toBe('split')
    if (out.kind !== 'split') return
    expect(out.parts).toHaveLength(1)
    expect(out.parts[0].amount).toBe(337)
    expect(face(out.parts[0].token)).toBe(337)
    for (const p of tokenProofs(out.parts[0].token)) expect(isSelfLocked(p.secret, xOnlyPub(ID))).toBe(true)
    // The change is a row of its own, the same voucher, and every sat is still here.
    const change = [...rows.entries()].find(([k, t]) => k.startsWith('split-') && t !== out.parts[0].token)!
    expect(face(change[1])).toBe(687)
    expect(parseVoucherToken(change[1]).voucher.voucherId).toBe(parseVoucherToken(c.token).voucher.voucherId)
    expect(rows.has(c.tokenId)).toBe(false)
    expect(held()).toBe(before)
    expect(split.loadSplitIntents(ME)).toEqual([])
    expect(moneyInFlight(ME).cashlinks).toBe(0)
  })

  it('a remainder whose whole proofs give part of the amount comes back as a second code part', async () => {
    const c = coupon([512, 256, 128], 'b')
    const out = await split.splitVoucher(ports, ME, { tokenId: c.tokenId, token: c.token, amount: 600 })
    expect(out.kind).toBe('split')
    if (out.kind !== 'split') return
    expect(out.parts.reduce((n, p) => n + p.amount, 0)).toBe(600)
    expect(out.parts[1].tokenId).toBe(c.tokenId)
  })

  it('a gateway without the route: refused before anything moves, coupon untouched', async () => {
    w.gateway.splitRoute = false
    const c = coupon([1024], 'a')
    const out = await split.splitVoucher(ports, ME, { tokenId: c.tokenId, token: c.token, amount: 337 })
    expect(out).toEqual({ kind: 'refused', why: 'split_route_unavailable' })
    expect(w.mint.log.swaps).toHaveLength(0)
    expect(rows.get(c.tokenId)).toBe(c.token)
    expect(split.loadSplitIntents(ME)).toEqual([])
  })

  it('the intent is on disk before the burn', async () => {
    const c = coupon([1024], 'a')
    const swap = w.mint.swap.bind(w.mint)
    let seen: unknown[] = []
    w.mint.swap = async (...args) => {
      seen = split.loadSplitIntents(ME)
      return swap(...args)
    }
    await split.splitVoucher(ports, ME, { tokenId: c.tokenId, token: c.token, amount: 337 })
    expect(seen).toHaveLength(1)
  })

  it('a definite refusal after the burn keeps the burnt sats, never loses them', async () => {
    const c = coupon([1024], 'a')
    w.gateway.splitAnswers.push({ status: 422, body: { refusal: 'SAT_BOUND_EXCEEDED' } })
    const before = held()
    const out = await split.splitVoucher(ports, ME, { tokenId: c.tokenId, token: c.token, amount: 337 })
    expect(out).toEqual({ kind: 'kept_as_sats', why: 'SAT_BOUND_EXCEEDED' })
    expect(w.kept).toHaveLength(1)
    expect(w.kept[0].sats).toBe(1024)
    expect(rows.has(c.tokenId)).toBe(false)
    expect(held()).toBe(before)
    expect(split.loadSplitIntents(ME)).toEqual([])
  })
})

describe('split, then a code (the whole #402 path)', () => {
  it('€10.24 → a €3.37 code: the split part, locked to me, is locked to S and deposited', async () => {
    const flow = await import('../checkoutCodeFlow')
    const records = await import('../checkoutCodeRecords')
    const { readLinkLock } = await import('../cashlinkLock')
    await W.loadTokenReader()
    const S = 'd4'.repeat(32)
    const X = NOW + 7 * 86_400
    const store = new W.FakeCodeStore(w.mint)
    const c = coupon([1024], 'a')
    const done = await split.splitVoucher(ports, ME, { tokenId: c.tokenId, token: c.token, amount: 337 })
    expect(done.kind).toBe('split')
    if (done.kind !== 'split') return
    const out = await flow.startCheckoutCode({
      ports: { ...ports, store, carve: async () => { throw new Error('no carve') }, consume: async (id) => void rows.delete(id), activity: async () => {} },
      pubkey: ME, stall: W.STALL, shop: { url: 'https://shop.example', redeemKey: S, platform: 'woocommerce', since: 1 },
      unit: 'GBP', decimals: 2, amount: 337, x: X, parts: done.parts,
    })
    expect(out.kind).toBe('issued')
    const r = records.loadCheckoutCodes(ME)[0]
    for (const p of tokenProofs(r.parts[0].lockedToken!)) expect(readLinkLock(p.secret)?.linkPub).toBe(S)
    expect(face(r.parts[0].lockedToken!)).toBe(337)
    // The split part's burn was K's witness over its secret: the mint accepted it as ours.
    const lock = w.gateway.calls.find((x) => x.path.endsWith('/cashlink/lock'))!
    expect(isSelfLocked((lock.body as { predecessor_secret: string }).predecessor_secret, xOnlyPub(ID))).toBe(true)
  })
})

describe('crash and retry', () => {
  it('the burn reply is lost: the next run finds the burn by NUT-09 and finishes, burning once', async () => {
    const c = coupon([1024], 'a')
    w.mint.loseNextReply = true
    const first = await split.splitVoucher(ports, ME, { tokenId: c.tokenId, token: c.token, amount: 337 })
    expect(first.kind).toBe('pending')
    expect(split.loadSplitIntents(ME)).toHaveLength(1)
    expect(moneyInFlight(ME).cashlinks).toBe(1)
    expect(await split.finishVoucherSplits(ports, ME)).toBe(1)
    expect(split.loadSplitIntents(ME)).toEqual([])
    expect(w.mint.log.swaps.filter((s) => s.inputs.some((i) => i.secret === tokenProofs(c.token)[0].secret))).toHaveLength(1)
    expect(commits).toBe(1)
  })

  it('the split answer is lost: the identical request is replayed, not a second set', async () => {
    const c = coupon([1024], 'a')
    w.gateway.loseNextSplit = true
    w.gateway.splitAnswers = []
    const first = await split.splitVoucher(ports, ME, { tokenId: c.tokenId, token: c.token, amount: 337 })
    expect(first.kind).toBe('pending')
    const retry = await split.splitVoucher(ports, ME, { tokenId: c.tokenId, token: c.token, amount: 337 })
    expect(retry.kind).toBe('split')
    const bodies = w.gateway.calls.filter((x) => x.path.endsWith('/bearer-split')).map((x) => JSON.stringify(x.body))
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    expect(new Set(bodies).size).toBe(1)
    expect(w.gateway.splits.size).toBe(1)
  })

  it('the page dies after the parts are minted but before the rows: the next run restores and writes once', async () => {
    const c = coupon([1024], 'a')
    const before = held()
    let fail = true
    const real = ports.commit
    ports.commit = async (...args) => {
      if (fail) {
        fail = false
        throw new Error('the page died')
      }
      return real(...args)
    }
    const first = await split.splitVoucher(ports, ME, { tokenId: c.tokenId, token: c.token, amount: 337 })
    expect(first.kind).toBe('pending')
    const again = await split.finishVoucherSplits(ports, ME)
    expect(again).toBe(1)
    expect(held()).toBe(before)
    expect(split.loadSplitIntents(ME)).toEqual([])
  })

  it('the mint is down at the burn: nothing moved, the intent stays, the next run finishes', async () => {
    const c = coupon([1024], 'a')
    const swap = w.mint.swap.bind(w.mint)
    w.mint.swap = async () => {
      throw new Error('mint unreachable')
    }
    const first = await split.splitVoucher(ports, ME, { tokenId: c.tokenId, token: c.token, amount: 337 })
    expect(first.kind).toBe('pending')
    expect(rows.get(c.tokenId)).toBe(c.token)
    w.mint.swap = swap
    expect(await split.finishVoucherSplits(ports, ME)).toBe(1)
    expect(rows.has(c.tokenId)).toBe(false)
  })
})
