/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools'

/**
 * #402, the customer's money path for a checkout code, against `cashlinkWorld` (a mint that really
 * signs and enforces NUT-11, the gateway's lock/re-sign/unlock/relay rules, and the code store's
 * deposit rules). Every test that moves value ends by counting where it is.
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const flow = await import('../checkoutCodeFlow')
const records = await import('../checkoutCodeRecords')
const { readLinkLock, deriveCheckoutRefundSecret, xOnlyPub } = await import('../cashlinkLock')
const { parseVoucherToken, tokenProofs, creditableFaceValue } = await import('../voucherToken')
const W = await import('./cashlinkWorld')
await W.loadTokenReader()

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const ID = hexToBytes('33'.repeat(32))
const ME = getPublicKey(ID)
const S = 'd4'.repeat(32)
const SHOP = { url: 'https://shop.example', redeemKey: S, platform: 'woocommerce' as const, since: 1 }

type World = ReturnType<typeof W.world>
let w: World
let store: InstanceType<typeof W.FakeCodeStore>
let consumed: string[]
let history: Array<{ id: string; memo: string }>
let ports: import('../checkoutCodeFlow').CheckoutPorts

function coupon(amounts: number[], nonce: string) {
  const proofs = amounts.map((a, n) => w.mint.issue(W.bearerSecret({ nonce: nonce.padEnd(8, 'n') }, `${nonce}${n}`), a))
  const token = W.tokenOf(proofs)
  return { tokenId: `row-${nonce}`, token, faceValue: creditableFaceValue(parseVoucherToken(token)).faceValue }
}

function part(c: ReturnType<typeof coupon>) {
  return { tokenId: c.tokenId, token: c.token, amount: c.faceValue, faceValue: c.faceValue }
}

const start = (parts: ReturnType<typeof part>[], extra = {}) =>
  flow.startCheckoutCode({ ports, pubkey: ME, stall: W.STALL, shop: SHOP, unit: 'GBP', decimals: 2, amount: parts.reduce((n, p) => n + p.amount, 0), x: X, parts, ...extra })

const only = () => records.loadCheckoutCodes(ME)[0]
const keptSats = () => w.kept.reduce((n, k) => n + (k.satsToken ? (k.sats ?? 0) : parseVoucherToken(k.token).tokenAmount), 0)
const lockedSats = (r = only()) => r.parts.reduce((n, p) => n + (p.lockedToken ? tokenProofs(p.lockedToken).reduce((m, q) => m + q.amount, 0) : 0), 0)

beforeEach(() => {
  w = W.world(NOW)
  store = new W.FakeCodeStore(w.mint)
  consumed = []
  history = []
  localStorage.clear()
  ports = {
    ...w.ports,
    store,
    identitySecret: () => Uint8Array.from(ID),
    carve: async () => {
      throw new Error('no split in this test')
    },
    consume: async (id) => void consumed.push(id),
    activity: async (row) => void history.push(row),
  }
})

describe('making a code', () => {
  it('happy path: one coupon, locked to S with its own R until x, refund at the relay signed by R, code issued', async () => {
    const c = coupon([64], 'a')
    const out = await start([part(c)])
    expect(out.kind).toBe('issued')
    const r = only()
    expect(r.status).toBe('reserved')
    expect(r.code).toMatch(/^IMANI[0-9A-Z]{12}$/)
    expect(r.codeHash).toBe(flow.codeHashOf(r.code!))
    const R = deriveCheckoutRefundSecret(ID, r.parts[0].i)
    for (const p of tokenProofs(r.parts[0].lockedToken!)) {
      expect(readLinkLock(p.secret)).toEqual({ linkPub: S, refundPub: xOnlyPub(R), locktime: X })
    }
    // Deposited at the relay, NIP-98 by R (not by S, not by the identity key).
    const deposits = w.gateway.calls.filter((c) => c.path.endsWith('/cashlink/refunds') && c.method === 'POST' && (c.body as { proof?: { secret?: string } }).proof?.secret)
    expect(deposits.length).toBe(1)
    expect(deposits[0].signedBy).toBe(xOnlyPub(R))
    expect(r.parts[0].armed).toBe(true)
    expect(consumed).toEqual(['row-a'])
    // The store got exactly the locked part, worth its credited face value.
    const sent = store.calls.find((c) => c.path === '/v1/checkout-codes')!.body as { parts: Array<{ amount: number }>; shop_key: string; expires_at: number }
    expect(sent.shop_key).toBe(S)
    expect(sent.expires_at).toBe(X)
    expect(sent.parts).toEqual([{ token: r.parts[0].lockedToken, amount: c.faceValue }])
    expect(lockedSats()).toBe(64)
    expect(records.checkoutCodesInFlight(ME)).toBe(1)
  })

  it('multi-part: two coupons, one multi-proof, each part its own R from a wallet-wide counter', async () => {
    const a = coupon([64], 'a')
    const b = coupon([64, 32], 'b')
    const out = await start([part(a), part(b)])
    expect(out.kind).toBe('issued')
    const r = only()
    expect(r.parts.map((p) => p.i)).toEqual([0, 1])
    const refunds = r.parts.map((p) => readLinkLock(tokenProofs(p.lockedToken!)[0].secret)!.refundPub)
    expect(new Set(refunds).size).toBe(2)
    expect(tokenProofs(r.parts[1].lockedToken!).length).toBe(2)
    expect(lockedSats()).toBe(160)
    // A second code never reuses an index.
    await start([part(coupon([16], 'c'))])
    expect(records.loadCheckoutCodes(ME)[0].parts[0].i).toBe(2)
  })

  it('a part that cannot be locked (no amount proof) stops the code before anything is burnt', async () => {
    const good = coupon([64], 'a')
    const bad = coupon([32], 'b')
    const stripped = W.tokenOf(tokenProofs(bad.token).map((p) => ({ amount: p.amount, id: p.id, secret: p.secret, C: p.C })))
    const out = await start([part(good), { ...part(bad), token: stripped }])
    expect(out.kind).toBe('refused')
    expect(w.mint.log.swaps.length).toBe(0)
    expect(store.calls.some((c) => c.path === '/v1/checkout-codes')).toBe(false)
    expect(records.checkoutCodesInFlight(ME)).toBe(0)
    expect(records.checkoutHeldTokenIds(ME).size).toBe(0)
    expect(consumed).toEqual([])
  })

  it('a partial lock failure after the burn: no code, the sats are kept, the locked part comes back at x', async () => {
    const a = coupon([64], 'a')
    const b = coupon([32], 'b')
    // The first lock is signed; the second is refused definitively after its burn.
    let n = 0
    const real = w.gateway.call.bind(w.gateway)
    w.gateway.call = async (m, path, body, signer) => {
      if (path.endsWith('/cashlink/lock') && (body as { burn_outputs: Array<{ amount: number }> }).burn_outputs.reduce((s, o) => s + o.amount, 0) === 32) {
        const answer = await real(m, path, body, signer)
        if (answer.status === 409) return answer
        n += 1
        return { status: 422, body: { refusal: 'NOT_AUTHORISED' } }
      }
      return real(m, path, body, signer)
    }
    const out = await start([part(a), part(b)])
    expect(out.kind).toBe('abandoned')
    expect(n).toBe(1)
    expect(store.calls.some((c) => c.path === '/v1/checkout-codes')).toBe(false)
    const r = only()
    expect(r.code).toBeUndefined()
    expect(r.parts.map((p) => p.state)).toEqual(['locked', 'kept'])
    expect(keptSats()).toBe(32)
    expect(records.checkoutCodesInFlight(ME)).toBe(1)
    // After x the locked part comes back by the relay refund, unlocked.
    W.at(w, X + 120)
    await w.gateway.runRelay(X + 120)
    expect(await flow.reconcileCheckoutCodes(ports, ME)).toBeGreaterThan(0)
    expect(only().done).toBe(true)
    expect(keptSats()).toBe(96)
    expect(records.checkoutCodesInFlight(ME)).toBe(0)
  })

  it('a deposit the relay refuses still issues the code: this wallet posts the same refund after x', async () => {
    // The first answer is the pre-check's probe (relay on), the second the real deposit.
    w.gateway.depositAnswers.push({ status: 422, body: { refusal: 'MALFORMED' } }, { status: 409, body: { refusal: 'CONFLICT' } })
    const out = await start([part(coupon([64], 'a'))])
    expect(out.kind).toBe('issued')
    expect(only().parts[0].armed).toBe(false)
    W.at(w, X + 120)
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only().done).toBe(true)
    expect(keptSats()).toBe(64)
  })

  it('the store refusing the deposit: no code, and every part comes back at x', async () => {
    store.nextDeposit = { status: 422, body: { refusal: 'WRONG_LOCK_KEY', part: 0 } }
    const out = await start([part(coupon([64], 'a'))])
    expect(out).toMatchObject({ kind: 'abandoned', why: 'WRONG_LOCK_KEY' })
    expect(records.checkoutCodesInFlight(ME)).toBe(1)
    W.at(w, X + 120)
    await w.gateway.runRelay(X + 120)
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(keptSats()).toBe(64)
    expect(records.checkoutCodesInFlight(ME)).toBe(0)
  })
})

describe('a page that dies, at each step, resumes from R and the proof', () => {
  it('after the burn (the reply was lost)', async () => {
    w.mint.loseNextReply = true
    const out = await start([part(coupon([64], 'a'))])
    expect(out.kind).toBe('pending')
    expect(only().parts[0].state).toBe('arming')
    const again = await flow.runCheckoutCode(ports, ME, only().id)
    expect(again.kind).toBe('issued')
    expect(lockedSats()).toBe(64)
  })

  it('after the lock was signed, before it was minted', async () => {
    const real = w.mint.swap.bind(w.mint)
    let swaps = 0
    w.mint.swap = async (...args) => {
      swaps += 1
      if (swaps === 2) throw new Error('page died')
      return real(...args)
    }
    expect((await start([part(coupon([64], 'a'))])).kind).toBe('pending')
    w.mint.swap = real
    expect((await flow.runCheckoutCode(ports, ME, only().id)).kind).toBe('issued')
    expect(lockedSats()).toBe(64)
  })

  it('after minting the lock (lost reply), before the relay deposit', async () => {
    const real = w.mint.swap.bind(w.mint)
    let swaps = 0
    w.mint.swap = async (...args) => {
      swaps += 1
      if (swaps === 2) w.mint.loseNextReply = true
      return real(...args)
    }
    expect((await start([part(coupon([64], 'a'))])).kind).toBe('pending')
    w.mint.swap = real
    expect((await flow.runCheckoutCode(ports, ME, only().id)).kind).toBe('issued')
    expect(lockedSats()).toBe(64)
    expect(w.gateway.deposits.size).toBe(1)
  })

  it('after every part is locked, before the store answered: the same idempotency key replays', async () => {
    store.down = true
    expect((await start([part(coupon([64], 'a')), part(coupon([32], 'b'))])).kind).toBe('pending')
    expect(only().status).toBe('depositing')
    store.down = false
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only().status).toBe('reserved')
    const code = only().code
    // A lost 201: run again, the store answers the same code.
    const r = only()
    r.status = 'depositing'
    records.saveCheckoutCode(ME, r)
    await flow.runCheckoutCode(ports, ME, r.id)
    expect(only().code).toBe(code)
    expect(store.codes.size).toBe(1)
  })
})

describe('after the code', () => {
  async function issued(parts = [part(coupon([64], 'a'))]) {
    expect((await start(parts)).kind).toBe('issued')
    return only()
  }
  const notice = (r: ReturnType<typeof only>, event: string, extra = {}) => ({ type: 'imani-checkout-code/1' as const, event: event as 'redeemed', code_hash: r.codeHash!, ...extra })

  it('redeemed: settled, out of flight, one Activity row "code used at shop: spent, back"', async () => {
    const r = await issued()
    W.shopSpends(w.mint, r.parts.map((p) => p.lockedToken!))
    expect(await flow.handleCheckoutNotice(ports, ME, notice(r, 'redeemed', { amount: 6 }), W.STORE_PUB)).toBe('handled')
    expect(only()).toMatchObject({ status: 'redeemed', done: true, spent: 6 })
    expect(records.checkoutCodesInFlight(ME)).toBe(0)
    expect(history).toHaveLength(1)
    expect(history[0].memo).toMatch(/code used at shop\.example: .*0\.06 spent, .*0\.02 back/)
  })

  it('a notice not sealed by the store is ignored', async () => {
    const r = await issued()
    expect(await flow.handleCheckoutNotice(ports, ME, notice(r, 'redeemed'), 'ee'.repeat(32))).toBe('ignored')
    expect(only().status).toBe('reserved')
  })

  it('cancelled: the R-locked coupons are unlocked through checkout/unlock and kept as ordinary coupons', async () => {
    const r = await issued([part(coupon([64], 'a')), part(coupon([32, 16], 'b'))])
    expect((await flow.cancelCheckoutCode(ports, ME, r.id)).ok).toBe(true)
    expect(only().status).toBe('cancelling')
    const tokens = W.returnToCustomer(w.mint, r.parts.map((p) => p.lockedToken!))
    expect(await flow.handleCheckoutNotice(ports, ME, notice(r, 'cancelled', { tokens }), W.STORE_PUB)).toBe('handled')
    expect(only()).toMatchObject({ status: 'cancelled', done: true })
    expect(w.kept.every((k) => !k.satsToken)).toBe(true)
    expect(keptSats()).toBe(112)
    for (const k of w.kept) expect(parseVoucherToken(k.token).voucher.lockKey).toBeUndefined()
    // A second delivery of the same notice keeps nothing twice.
    await flow.handleCheckoutNotice(ports, ME, notice(r, 'cancelled', { tokens }), W.STORE_PUB)
    expect(keptSats()).toBe(112)
  })

  it('change without the unlock route yet: retried, never lost', async () => {
    const r = await issued()
    w.gateway.unlockRoute = false
    const tokens = W.returnToCustomer(w.mint, r.parts.map((p) => p.lockedToken!))
    expect(await flow.handleCheckoutNotice(ports, ME, notice(r, 'change', { tokens }), W.STORE_PUB)).toBe('retry')
    w.gateway.unlockRoute = true
    expect(await flow.handleCheckoutNotice(ports, ME, notice(r, 'change', { tokens }), W.STORE_PUB)).toBe('handled')
    expect(keptSats()).toBe(64)
  })

  it('expired: every part comes back by the relay refund path', async () => {
    const r = await issued([part(coupon([64], 'a')), part(coupon([32], 'b'))])
    W.at(w, X + 120)
    await w.gateway.runRelay(X + 120)
    expect(await flow.handleCheckoutNotice(ports, ME, notice(r, 'expired'), W.STORE_PUB)).toBe('handled')
    expect(only().done).toBe(true)
    expect(keptSats()).toBe(96)
    expect(history[0].memo).toMatch(/expired unused/)
  })

  it('GET /mine is the fallback for a lost "redeemed" notice', async () => {
    const r = await issued()
    store.byCode(r.code!)!.status = 'redeemed'
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only()).toMatchObject({ status: 'redeemed', done: true })
  })
})

describe('notices', () => {
  it('parses only the contract shape', () => {
    expect(flow.parseCheckoutNotice('{"type":"imani-checkout-code/1","event":"redeemed","code_hash":"' + 'a'.repeat(64) + '","amount":800}')).not.toBeNull()
    expect(flow.parseCheckoutNotice('{"type":"imani-checkout-code/1","event":"stolen","code_hash":"' + 'a'.repeat(64) + '"}')).toBeNull()
    expect(flow.parseCheckoutNotice('{"type":"other"}')).toBeNull()
    expect(flow.parseCheckoutNotice('not json')).toBeNull()
  })
})
