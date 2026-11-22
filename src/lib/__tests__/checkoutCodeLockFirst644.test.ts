/**
 * @vitest-environment jsdom
 *
 * #644: the lock check runs on the voucher a split would carve, BEFORE the split, read-only, and the
 * gateway's refusal name is kept so the customer can read it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools'

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const flow = await import('../checkoutCodeFlow')
const records = await import('../checkoutCodeRecords')
const { LOCK_PATH } = await import('../cashlinkFlow')
const { parseVoucherToken, creditableFaceValue } = await import('../voucherToken')
const W = await import('./cashlinkWorld')
await W.loadTokenReader()

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const ID = hexToBytes('33'.repeat(32))
const ME = getPublicKey(ID)
const SHOP = { url: 'https://shop.example', redeemKey: 'd4'.repeat(32), platform: 'woocommerce' as const, since: 1 }

let w: ReturnType<typeof W.world>
let ports: import('../checkoutCodeFlow').CheckoutPorts

function coupon(amounts: number[], nonce: string) {
  const proofs = amounts.map((a, n) => w.mint.issue(W.bearerSecret({ nonce: nonce.padEnd(8, 'n') }, `${nonce}${n}`), a))
  const token = W.tokenOf(proofs)
  return { tokenId: `row-${nonce}`, token, faceValue: creditableFaceValue(parseVoucherToken(token)).faceValue }
}

beforeEach(() => {
  localStorage.clear()
  w = W.world(NOW)
  const store = new W.FakeCodeStore(w.mint)
  ports = {
    ...w.ports,
    store,
    identitySecret: () => Uint8Array.from(ID),
    carve: async () => {
      throw new Error('no carve in this test')
    },
    consume: async () => {},
    activity: async () => {},
  } as unknown as import('../checkoutCodeFlow').CheckoutPorts
})

const check = (token: string) => flow.checkCheckoutSource({ ports, stall: W.STALL, shop: SHOP, unit: 'GBP', x: X, token })

describe('checkCheckoutSource (#644)', () => {
  it('a voucher the shop lock would take passes, and nothing is burnt', async () => {
    expect(await check(coupon([64], 'a').token)).toBeNull()
    expect(w.mint.log.swaps.length).toBe(0)
  })

  it('a refused dry lock is refused before any split, with the gateway reason, and nothing is burnt', async () => {
    w.gateway.override.set(LOCK_PATH, { status: 422, body: { refusal: 'SHOP_KEY_UNKNOWN' } })
    expect(await check(coupon([64], 'a').token)).toEqual({ why: 'lock_refused', detail: 'SHOP_KEY_UNKNOWN' })
    expect(w.mint.log.swaps.length).toBe(0)
  })

  it('a voucher from another stall is refused without asking anyone', async () => {
    const before = w.gateway.calls.length
    expect(await check('cashuBnot-a-voucher')).toEqual({ why: 'not_this_stall' })
    expect(w.gateway.calls.length).toBe(before)
  })
})

describe('startCheckoutCode keeps the gateway reason (#644)', () => {
  it('a refused dry lock records refusalDetail', async () => {
    w.gateway.override.set(LOCK_PATH, { status: 422, body: { refusal: 'SHOP_KEY_UNKNOWN' } })
    const c = coupon([64], 'a')
    const out = await flow.startCheckoutCode({ ports, pubkey: ME, stall: W.STALL, shop: SHOP, unit: 'GBP', decimals: 2, amount: c.faceValue, x: X, parts: [{ tokenId: c.tokenId, token: c.token, amount: c.faceValue, faceValue: c.faceValue }] })
    expect(out).toMatchObject({ kind: 'refused', why: 'lock_refused' })
    expect(out.record.refusalDetail).toBe('SHOP_KEY_UNKNOWN')
    expect(records.loadCheckoutCodes(ME)[0].refusalDetail).toBe('SHOP_KEY_UNKNOWN')
    expect(w.mint.log.swaps.length).toBe(0)
  })
})
