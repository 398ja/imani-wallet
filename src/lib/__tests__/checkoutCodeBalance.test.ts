/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools'

/**
 * #472 (option A): a code keeps what an order did not use, for whoever holds it, until `x`. Against
 * `cashlinkWorld` (a mint that really signs and enforces NUT-11, the relay's deposit rules, and the
 * code store's `/parts` and `/mine`). The wallet never trusts the store alone: the mint says what is
 * spent, and every balance successor is checked against the record before it is adopted.
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const flow = await import('../checkoutCodeFlow')
const records = await import('../checkoutCodeRecords')
const { readLinkLock, deriveCheckoutRefundSecret, xOnlyPub } = await import('../cashlinkLock')
const { parseVoucherToken, tokenProofs, creditableFaceValue } = await import('../voucherToken')
const { checkoutCodeRow } = await import('../checkoutCodeHistory')
const W = await import('./cashlinkWorld')
await W.loadTokenReader()

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const ID = hexToBytes('33'.repeat(32))
const ME = getPublicKey(ID)
const S = 'd4'.repeat(32)
const SHOP = { url: 'https://shop.example', redeemKey: S, platform: 'woocommerce' as const, since: 1 }

let w: ReturnType<typeof W.world>
let store: InstanceType<typeof W.FakeCodeStore>
let history: Array<{ id: string; memo: string; amount: number }>
let used: Array<{ id: string; memo: string; amount: number }>
let changes: Array<{ id: string; amount: number }>
let ports: import('../checkoutCodeFlow').CheckoutPorts

function coupon(amounts: number[], nonce: string) {
  const proofs = amounts.map((a, n) => w.mint.issue(W.bearerSecret({ nonce: nonce.padEnd(8, 'n') }, `${nonce}${n}`), a))
  const token = W.tokenOf(proofs)
  const faceValue = creditableFaceValue(parseVoucherToken(token)).faceValue
  return { tokenId: `row-${nonce}`, token, amount: faceValue, faceValue }
}

const only = () => records.loadCheckoutCodes(ME)[0]
const stored = () => W.currentParts([...store.codes.values()][0]) && [...store.codes.values()][0]
const face = (token: string) => creditableFaceValue(parseVoucherToken(token)).faceValue
const keptSats = () => w.kept.reduce((n, k) => n + (k.satsToken ? (k.sats ?? 0) : parseVoucherToken(k.token).tokenAmount), 0)
const notice = (event: string, extra: Record<string, unknown> = {}) => ({ type: 'imani-checkout-code/1' as const, event: event as 'rebalanced', code_hash: only().codeHash!, ...extra })
const deposits = () => w.gateway.calls.filter((c) => c.path.endsWith('/cashlink/refunds') && c.method === 'POST')

/** Three 64-sat coupons (8 p each): a code worth 24 p. */
async function threePartCode() {
  const parts = [coupon([64], 'a'), coupon([64], 'b'), coupon([64], 'c')]
  const out = await flow.startCheckoutCode({ ports, pubkey: ME, stall: W.STALL, shop: SHOP, unit: 'GBP', decimals: 2, amount: 24, x: X, parts })
  expect(out.kind).toBe('issued')
  expect(only()).toMatchObject({ amount: 24, remaining: 24, redemptions: [] })
  return only()
}

/**
 * The shop's balance order: part `spend` goes whole to the stall, part `split` is split, `sats`
 * re-locked to S (rule 4b), the rest untouched. The store's `/parts` then lists what is left.
 */
function order(spend: number[], split?: { idx: number; sats: number; tamper?: Parameters<typeof W.shopRelocks>[3] }) {
  const c = stored()
  const now = W.currentParts(c)
  for (const idx of spend) W.shopSpends(w.mint, [now.find((p) => p.idx === idx)!.token])
  const next = now.filter((p) => !spend.includes(p.idx)).map((p) => {
    if (split?.idx !== p.idx) return p
    const token = W.shopRelocks(w.mint, p.token, split.sats, split.tamper, `o${(c.current?.length ?? 9)}${p.idx}`)
    return { idx: p.idx, token, amount: face(token) }
  })
  c.current = next
  return next
}

beforeEach(() => {
  w = W.world(NOW)
  store = new W.FakeCodeStore(w.mint)
  history = []
  used = []
  changes = []
  localStorage.clear()
  ports = {
    ...w.ports,
    store,
    identitySecret: () => Uint8Array.from(ID),
    carve: async () => {
      throw new Error('no split in this test')
    },
    consume: async () => {},
    activity: async (row) => void history.push(row),
    usedActivity: async (row) => void used.push(row),
    changeActivity: async (row) => void changes.push(row),
  }
})

describe('the rebalanced notice', () => {
  it('parses only with remaining', () => {
    const h = 'a'.repeat(64)
    expect(flow.parseCheckoutNotice(JSON.stringify({ type: 'imani-checkout-code/1', event: 'rebalanced', code_hash: h, amount: 800, remaining: 1700 }))).toMatchObject({ remaining: 1700 })
    expect(flow.parseCheckoutNotice(JSON.stringify({ type: 'imani-checkout-code/1', event: 'rebalanced', code_hash: h, amount: 800 }))).toBeNull()
    expect(flow.parseCheckoutNotice(JSON.stringify({ type: 'imani-checkout-code/1', event: 'rebalanced', code_hash: h, remaining: -1 }))).toBeNull()
  })

  it('happy path: the spent part settled (after the mint says SPENT), the split part replaced and re-armed by R, the untouched one kept', async () => {
    const before = await threePartCode()
    const oldB = before.parts[1].lockedToken!
    const oldC = before.parts[2].lockedToken!
    const depositsBefore = deposits().length
    const next = order([0], { idx: 1, sats: 32 })
    expect(await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { amount: 12, remaining: 12 }), W.STORE_PUB)).toBe('handled')
    const r = only()
    expect(r.status).toBe('reserved')
    expect(r.done).toBeFalsy()
    expect(r.remaining).toBe(12)
    expect(r.redemptions).toEqual([{ at: expect.any(Number), amount: 12, remaining: 12 }])
    expect(r.parts.map((p) => p.state)).toEqual(['settled', 'locked', 'locked'])
    // The successor: its new token and amount, the old one kept for audit, re-armed.
    expect(r.parts[1]).toMatchObject({ lockedToken: next[0].token, amount: 4, armed: true, replacedTokens: [oldB] })
    expect(r.parts[2]).toMatchObject({ lockedToken: oldC, amount: 8, armed: true })
    expect(r.parts[2].replacedTokens).toBeUndefined()
    // Re-armed exactly as a fresh part: one deposit per proof of the NEW token, NIP-98 by this part's R.
    const R = deriveCheckoutRefundSecret(ID, r.parts[1].i)
    const fresh = deposits().slice(depositsBefore)
    expect(fresh.length).toBe(1)
    expect(fresh[0].signedBy).toBe(xOnlyPub(R))
    expect((fresh[0].body as { proof: { secret: string } }).proof.secret).toBe(tokenProofs(next[0].token)[0].secret)
    // History: one row for this use, never a change row.
    expect(used).toEqual([expect.objectContaining({ id: `checkout:${r.id}:used:1`, amount: 12, memo: '£0.12 used at shop.example, £0.12 left on the code' })])
    expect(changes).toEqual([])
    expect(checkoutCodeRow(r)).toMatchObject({ amount: 12, checkoutCode: { remaining: 12 } })
    expect(records.checkoutCodesInFlight(ME)).toBe(1)
  })

  it('a second delivery changes nothing', async () => {
    await threePartCode()
    order([0], { idx: 1, sats: 32 })
    await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { amount: 12, remaining: 12 }), W.STORE_PUB)
    const first = JSON.stringify(only())
    const n = deposits().length
    expect(await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { amount: 12, remaining: 12 }), W.STORE_PUB)).toBe('handled')
    expect(JSON.stringify(only())).toBe(first)
    expect(deposits().length).toBe(n)
    expect(used.length).toBe(1)
  })

  it('a notice not sealed by the store is ignored, and /parts is not even read', async () => {
    await threePartCode()
    order([0], { idx: 1, sats: 32 })
    const first = JSON.stringify(only())
    expect(await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { remaining: 12 }), 'ee'.repeat(32))).toBe('ignored')
    expect(store.calls.some((c) => c.path.endsWith('/parts'))).toBe(false)
    expect(JSON.stringify(only())).toBe(first)
  })

  const OTHER = 'e5'.repeat(32)
  it.each([
    ['another S', { data: `02${OTHER}` }],
    ['another x', { locktime: String(X + 86_400) }],
    ['another R', { refund: `02${OTHER}` }],
    ['another voucher', { voucherId: '00000000-0000-4000-8000-000000000000' }],
    ['not gateway-signed', { unsigned: true }],
  ])('a successor locked to %s is refused and the part is left exactly as it was', async (_what, tamper) => {
    const before = await threePartCode()
    order([0], { idx: 1, sats: 32, tamper })
    expect(await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { remaining: 12 }), W.STORE_PUB)).toBe('retry')
    const r = only()
    expect(r.parts[1]).toEqual(before.parts[1])
    expect(r.parts[2]).toEqual(before.parts[2])
    // The honest part of the answer still counts; the refused part is still worth what it was.
    expect(r.parts[0].state).toBe('settled')
    expect(r.remaining).toBe(16)
  })

  it('a successor worth what the store does not say is refused', async () => {
    const before = await threePartCode()
    order([0], { idx: 1, sats: 32 })
    stored().current![0].amount = 5
    expect(await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { remaining: 13 }), W.STORE_PUB)).toBe('retry')
    expect(only().parts[1]).toEqual(before.parts[1])
  })

  it('a part missing from /parts while the mint says UNSPENT is not marked settled', async () => {
    await threePartCode()
    stored().current = W.currentParts(stored()).filter((p) => p.idx !== 0) // the store "forgets" part 0, unspent
    expect(await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { remaining: 16 }), W.STORE_PUB)).toBe('retry')
    const r = only()
    expect(r.parts[0].state).toBe('locked')
    expect(r.remaining).toBe(24)
    expect(r.redemptions).toEqual([])
  })

  it('three partial uses down to redeemed', async () => {
    await threePartCode()
    order([0], { idx: 1, sats: 32 }) // 24 -> 12
    await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { remaining: 12 }), W.STORE_PUB)
    order([2]) // 12 -> 4
    expect(await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { remaining: 4 }), W.STORE_PUB)).toBe('handled')
    expect(only()).toMatchObject({ status: 'reserved', remaining: 4 })
    order([1]) // 4 -> 0: the store says `redeemed`, remaining 0, with the last order's amount
    expect(await flow.handleCheckoutNotice(ports, ME, notice('redeemed', { amount: 4, remaining: 0 }), W.STORE_PUB)).toBe('handled')
    const r = only()
    expect(r).toMatchObject({ status: 'redeemed', remaining: 0, spent: 4, done: true })
    expect(r.redemptions!.map((u) => [u.amount, u.remaining])).toEqual([[12, 12], [8, 4], [4, 0]])
    expect(used.map((u) => u.memo)).toEqual(['£0.12 used at shop.example, £0.12 left on the code', '£0.08 used at shop.example, £0.04 left on the code'])
    expect(history.at(-1)!.memo).toBe('£0.04 used at shop.example: nothing left on the code')
    expect(checkoutCodeRow(r)).toMatchObject({ amount: 4 })
    expect(records.checkoutCodesInFlight(ME)).toBe(0)
  })

  it('a lost rebalanced is caught by reconcile via GET /mine', async () => {
    await threePartCode()
    order([0], { idx: 1, sats: 32 })
    expect(await flow.reconcileCheckoutCodes(ports, ME)).toBeGreaterThan(0)
    const r = only()
    expect(r).toMatchObject({ status: 'reserved', remaining: 12 })
    expect(r.parts[1].armed).toBe(true)
    expect(used.length).toBe(1)
    // And again changes nothing.
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(used.length).toBe(1)
  })

  it('at x after a rebalance: the NEW token comes back (relay), the untouched part too', async () => {
    await threePartCode()
    order([0], { idx: 1, sats: 32 })
    await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { remaining: 12 }), W.STORE_PUB)
    W.at(w, X + 120)
    await w.gateway.runRelay(X + 120)
    expect(await flow.handleCheckoutNotice(ports, ME, notice('expired', { amount: 12 }), W.STORE_PUB)).toBe('handled')
    expect(only()).toMatchObject({ status: 'expired', done: true })
    expect(keptSats()).toBe(32 + 64)
    expect(history.at(-1)!.memo).toBe('£0.12 left on the code expired: back in your wallet')
  })

  it('at x, a successor whose re-arm failed still comes back (this wallet posts the refund itself)', async () => {
    await threePartCode()
    order([0], { idx: 1, sats: 32 })
    w.gateway.relayOn = false
    await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { remaining: 12 }), W.STORE_PUB)
    expect(only().parts[1]).toMatchObject({ armed: false, amount: 4 })
    W.at(w, X + 120)
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only().done).toBe(true)
    expect(keptSats()).toBe(32 + 64)
  })

  it('a successor whose re-arm failed is re-armed on a later pass before x', async () => {
    await threePartCode()
    order([0], { idx: 1, sats: 32 })
    w.gateway.relayOn = false
    await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { remaining: 12 }), W.STORE_PUB)
    expect(only().parts[1].armed).toBe(false)
    w.gateway.relayOn = true
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only().parts[1].armed).toBe(true)
  })

  it('dust: the last order below the threshold uses today\'s change + unlock, recorded once', async () => {
    await threePartCode()
    order([0], { idx: 1, sats: 32 })
    await flow.handleCheckoutNotice(ports, ME, notice('rebalanced', { remaining: 12 }), W.STORE_PUB)
    // The next order takes 8 of 12 and leaves 4, below dust: today's flow, the parts burnt, change to R.
    const left = only().parts.filter((p) => p.state === 'locked').map((p) => p.lockedToken!)
    const tokens = W.returnToCustomer(w.mint, [left[0]]) // the 4 p successor comes back as change
    W.shopSpends(w.mint, [left[1]])
    expect(await flow.handleCheckoutNotice(ports, ME, notice('redeemed', { amount: 12, remaining: 0 }), W.STORE_PUB)).toBe('handled')
    expect(await flow.handleCheckoutNotice(ports, ME, notice('change', { tokens }), W.STORE_PUB)).toBe('handled')
    const r = only()
    expect(r).toMatchObject({ status: 'redeemed', change: 4, spent: 8, done: true })
    expect(r.redemptions!.at(-1)).toMatchObject({ amount: 8, remaining: 0 })
    expect(changes.length).toBe(1)
    expect(keptSats()).toBe(32)
    for (const k of w.kept) for (const p of tokenProofs(k.token)) expect(readLinkLock(p.secret)).toBeNull()
  })

})

describe('a lost rebalanced, then x (review 2026-11-02: the balance was lost)', () => {
  it('the expired notice adopts the successor first and refunds it to R: what was left comes back', async () => {
    await threePartCode()
    order([0], { idx: 1, sats: 32 }) // the rebalanced notice never arrives
    W.at(w, X + 120)
    await w.gateway.runRelay(X + 120)
    let out = await flow.handleCheckoutNotice(ports, ME, notice('expired', { amount: 12 }), W.STORE_PUB)
    if (out === 'retry') out = await flow.handleCheckoutNotice(ports, ME, notice('expired', { amount: 12 }), W.STORE_PUB)
    expect(out).toBe('handled')
    const r = only()
    expect(r).toMatchObject({ status: 'expired', done: true, remaining: 12 })
    expect(r.parts[1].replacedTokens?.length).toBe(1)
    // 32 sats of the successor + the untouched 64: 12 p, exactly what was left.
    expect(keptSats()).toBe(32 + 64)
    expect(w.kept.reduce((n, k) => n + face(k.token), 0)).toBe(12)
    expect(used.length).toBe(1)
  })

  it('reconcile after x with no notice at all does the same', async () => {
    await threePartCode()
    order([0], { idx: 1, sats: 32 })
    W.at(w, X + 120)
    await flow.reconcileCheckoutCodes(ports, ME)
    await flow.reconcileCheckoutCodes(ports, ME)
    const r = only()
    expect(r).toMatchObject({ status: 'expired', done: true, remaining: 12 })
    expect(keptSats()).toBe(32 + 64)
    expect(used.length).toBe(1)
  })

  it('/parts unreachable at x: a spent old token is not called finished; the next pass, reachable, brings the successor back', async () => {
    await threePartCode()
    order([0], { idx: 1, sats: 32 })
    W.at(w, X + 120)
    const real = store.call.bind(store)
    store.call = async (m, path, body) => (path.endsWith('/parts') ? { status: 503, body: null } : real(m, path, body))
    expect(await flow.handleCheckoutNotice(ports, ME, notice('expired', { amount: 12 }), W.STORE_PUB)).toBe('retry')
    await flow.reconcileCheckoutCodes(ports, ME)
    let r = only()
    expect(r.done).toBeFalsy()
    // The untouched part came back as today; the spent ones wait.
    expect(r.parts[2].state).toBe('settled')
    expect(r.parts[0].state).toBe('locked')
    expect(r.parts[1].state).toBe('locked')
    store.call = real
    await flow.reconcileCheckoutCodes(ports, ME)
    r = only()
    expect(r).toMatchObject({ done: true, remaining: 12 })
    expect(keptSats()).toBe(32 + 64)
  })
})
