import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

/**
 * Owner rule 2026-10-13 on the cashback paths (`/c/` link and code): a merchant account takes only
 * its own stall's vouchers. Refused BEFORE the destructive ciphertext fetch when the portal names
 * the issuer, so a merchant never spends a customer's claim; and before the swap when only the
 * token names it, keeping the token stashed (never lost).
 */

const h = vi.hoisted(() => ({
  account: '',
  role: 'customer' as 'merchant' | 'customer' | 'unknown',
  redeemed: [] as string[],
  serverRefuses: false,
}))

vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({}),
  withCorrelation: async (_ids: unknown, run: (id: string) => unknown) => run('corr-test'),
}))
vi.mock('../wallet', () => ({ notifyWalletChanged: () => {}, recordCashbackStatus: async () => {} }))
vi.mock('../nip98', () => ({ signedFetch: async () => new Response('{}', { status: 200 }) }))
vi.mock('../nap', () => ({ getSigner: () => ({ pubkey: h.account }) }))
vi.mock('../merchant', async (orig) => ({
  ...(await orig<typeof import('../merchant')>()),
  loadMerchant: () => null,
  merchantStatus: async () => h.role,
}))

const { redeemClaimRef, pendingCashbackCount } = await import('../cashback')
const { clearConfigCache } = await import('../config')
const { resetGate } = await import('./trustedMintKit')
const { buildVoucherToken } = await import('./voucherFixtures')

const ORIGIN = 'cashback.example.test'
const CLAIM_REF = 'abcd1234efgh5678'
const MINT = 'http://mint.test'
const STALL_A_KEY = generateSecretKey()
const STALL_A = getPublicKey(STALL_A_KEY)
const STALL_B_KEY = generateSecretKey()
const STALL_B = getPublicKey(STALL_B_KEY)

const store = new Map<string, string>()

beforeEach(() => {
  resetGate()
  clearConfigCache()
  store.clear()
  h.redeemed.length = 0
  h.role = 'customer'
  h.serverRefuses = false
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('window', {
    TokenRedemption: {
      async redeem(token: string) {
        if (h.serverRefuses) throw Object.assign(new Error('HTTP 403'), { code: 'FOREIGN_VOUCHER_FOR_MERCHANT' })
        h.redeemed.push(token)
        return {}
      },
    },
  })
})
afterEach(() => vi.unstubAllGlobals())

async function sealed(token: string) {
  const keyBytes = new Uint8Array(32).fill(0)
  const iv = new Uint8Array(12).fill(7)
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'])
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token))
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return { ciphertext: b64(new Uint8Array(buf)), iv: b64(iv), key: b64(keyBytes) }
}

function stub(meta: Record<string, unknown>, seal: { ciphertext: string; iv: string }) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input)
    calls.push(url)
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.startsWith('/api/v1/config')) {
      return json(200, { default_domain: 'x.test', cashback_origins: [ORIGIN], token_mint_urls: [MINT] })
    }
    if (url.includes('/cashback/public/')) return json(200, meta)
    if (url.includes('/ciphertext')) return json(200, seal)
    throw new Error(`unexpected fetch: ${url}`)
  })
  return calls
}

describe('a merchant and another stall\u2019s cashback', () => {
  it('is refused before the destructive claim when the portal names the issuer', async () => {
    h.account = STALL_A
    h.role = 'merchant'
    const token = buildVoucherToken({}, [8], {}, STALL_B_KEY).token
    const seal = await sealed(token)
    const calls = stub({ amountMinor: 500, unit: 'EUR', issuerPubkey: STALL_B }, seal)

    const result = await redeemClaimRef(CLAIM_REF, seal.key)

    expect(result).toEqual({ kind: 'merchant_refused', reason: 'merchant' })
    expect(calls.some((c) => c.includes('/ciphertext'))).toBe(false)
    expect(h.redeemed).toEqual([])
  })

  it('is refused before the swap when only the token names the issuer, and the token is kept', async () => {
    h.account = STALL_A
    h.role = 'merchant'
    const token = buildVoucherToken({}, [8], {}, STALL_B_KEY).token
    const seal = await sealed(token)
    stub({ amountMinor: 500, unit: 'EUR' }, seal)

    const result = await redeemClaimRef(CLAIM_REF, seal.key)

    expect(result).toEqual({ kind: 'merchant_refused', reason: 'merchant' })
    expect(h.redeemed).toEqual([])
    expect(pendingCashbackCount()).toBe(1)
  })

  it('an unknown role is refused a foreign cashback before the claim', async () => {
    h.account = STALL_A
    h.role = 'unknown'
    const seal = await sealed(buildVoucherToken({}, [8], {}, STALL_B_KEY).token)
    const calls = stub({ issuerPubkey: STALL_B }, seal)

    expect(await redeemClaimRef(CLAIM_REF, seal.key)).toEqual({ kind: 'merchant_refused', reason: 'unknown' })
    expect(calls.some((c) => c.includes('/ciphertext'))).toBe(false)
  })

  it('a server refusal (403 FOREIGN_VOUCHER_FOR_MERCHANT) is reported, not swallowed', async () => {
    h.account = STALL_A
    h.role = 'customer' // the wallet thought so; the server knows better
    h.serverRefuses = true
    const seal = await sealed(buildVoucherToken({}, [8], {}, STALL_B_KEY).token)
    stub({ issuerPubkey: STALL_B }, seal)

    expect(await redeemClaimRef(CLAIM_REF, seal.key)).toEqual({ kind: 'merchant_refused', reason: 'merchant' })
    expect(pendingCashbackCount()).toBe(1)
  })
})

describe('everyone else is unchanged', () => {
  it('a customer banks another stall\u2019s cashback', async () => {
    h.account = getPublicKey(generateSecretKey())
    h.role = 'customer'
    const token = buildVoucherToken({}, [8], {}, STALL_B_KEY).token
    const seal = await sealed(token)
    stub({ amountMinor: 500, unit: 'EUR', issuerPubkey: STALL_B }, seal)

    expect((await redeemClaimRef(CLAIM_REF, seal.key)).kind).toBe('ok')
    expect(h.redeemed).toEqual([token])
  })

  it('a merchant\u2019s own voucher is never asked about, even with the role unknown', async () => {
    h.account = STALL_A
    h.role = 'unknown'
    const token = buildVoucherToken({}, [8], {}, STALL_A_KEY).token
    const seal = await sealed(token)
    stub({ amountMinor: 500, unit: 'EUR', issuerPubkey: STALL_A }, seal)

    expect((await redeemClaimRef(CLAIM_REF, seal.key)).kind).toBe('ok')
  })
})
