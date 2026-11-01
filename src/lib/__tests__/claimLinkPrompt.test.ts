import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchClaimSummary, redeemClaimRef } from '../cashback'
import { clearConfigCache } from '../config'
import { resetGate } from './trustedMintKit'
import { buildPlainToken } from './voucherFixtures'

/**
 * Claim links phase 1, at the library level: the prompt's read is non-destructive, and the claim
 * key never leaves the device (imani-docs/wallet/spec-claim-links.md, sections 2.4 and 6.7).
 *
 * The page test mocks this module, so the guarantees it states about requests are proved here,
 * against the real functions and a recording `fetch`.
 */

vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({}),
  withCorrelation: async (_ids: unknown, run: (id: string) => unknown) => run('corr-test'),
}))
vi.mock('../wallet', () => ({ notifyWalletChanged: () => {}, recordCashbackStatus: async () => {} }))
vi.mock('../nip98', () => ({ signedFetch: async () => new Response('{}', { status: 200 }) }))

const ORIGIN = 'cashback.example.test'
const MINT = 'https://mint.example.test'
const REF = 'abcd1234efgh5678'
const ISSUER = 'a'.repeat(64)

const store = new Map<string, string>()
const requests: Array<{ url: string; headers: Record<string, string> }> = []
const logged: string[] = []

async function sealed(token: string) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'])
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token))
  return { ciphertext: b64url(new Uint8Array(buf)), iv: b64url(iv), key: b64url(keyBytes) }
}
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stub(seal: { ciphertext: string; iv: string }, meta: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    requests.push({ url, headers })
    if (url.startsWith('/api/v1/config')) {
      return json(200, { default_domain: 'x.test', cashback_origins: [ORIGIN], token_mint_urls: [MINT] })
    }
    if (url.includes('/cashback/public/')) {
      return json(200, {
        claimRef: REF, status: 'Unclaimed', amountMinor: 500, unit: 'EUR', decimals: 2, memo: null,
        expiresAt: '2026-11-10T12:00:00Z', claimedAt: null, revokedAt: null, issuerPubkey: ISSUER.toUpperCase(),
        ...meta,
      })
    }
    if (url.endsWith('/ciphertext')) return json(200, { ciphertext: seal.ciphertext, iv: seal.iv, issuerPubkey: ISSUER })
    throw new Error(`unexpected fetch: ${url}`)
  })
}

beforeEach(() => {
  resetGate()
  clearConfigCache()
  store.clear()
  requests.length = 0
  logged.length = 0
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('window', { TokenRedemption: { redeem: async () => ({}) } })
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetGate()
})

describe('fetchClaimSummary (what the prompt reads before the tap)', () => {
  it('reads the public metadata and never touches the destructive ciphertext endpoint', async () => {
    const seal = await sealed(buildPlainToken(MINT, 'sat', [8]))
    stub(seal)

    const summary = await fetchClaimSummary(REF)

    expect(summary).toMatchObject({
      kind: 'ok', status: 'Unclaimed', amountMinor: 500, unit: 'EUR', decimals: 2,
      issuerPubkey: ISSUER, mintTrusted: true,
    })
    expect(requests.some((r) => r.url.includes('/ciphertext'))).toBe(false)
  })

  it('reads the same voucher any number of times without spending it', async () => {
    const seal = await sealed(buildPlainToken(MINT, 'sat', [8]))
    stub(seal)
    for (let i = 0; i < 5; i++) await fetchClaimSummary(REF)
    expect(requests.filter((r) => r.url.includes('/ciphertext'))).toEqual([])
  })

  it('refuses a malformed ref without a request', async () => {
    stub(await sealed('x'))
    expect(await fetchClaimSummary('../../etc')).toEqual({ kind: 'not_found' })
    expect(requests.filter((r) => r.url.includes('/cashback/'))).toEqual([])
  })

  it('maps 404 to not_found and a network failure to unreachable', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input)
      if (url.startsWith('/api/v1/config')) return json(200, { default_domain: 'x', cashback_origins: [ORIGIN] })
      return json(404, {})
    })
    expect(await fetchClaimSummary(REF)).toEqual({ kind: 'not_found' })

    clearConfigCache()
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).startsWith('/api/v1/config')) return json(200, { default_domain: 'x', cashback_origins: [ORIGIN] })
      throw new TypeError('offline')
    })
    expect(await fetchClaimSummary(REF)).toEqual({ kind: 'unreachable' })
  })

  it('reports a deployment with no cashback origins as disabled', async () => {
    vi.stubGlobal('fetch', async () => json(200, { default_domain: 'x', cashback_origins: [] }))
    expect(await fetchClaimSummary(REF)).toEqual({ kind: 'disabled' })
  })
})

describe('the claim key never leaves the device', () => {
  it('is in no request URL, no header and no log line, from the prompt read to the redeem', async () => {
    const seal = await sealed(buildPlainToken(MINT, 'sat', [8, 2]))
    stub(seal)

    await fetchClaimSummary(REF)
    const result = await redeemClaimRef(REF, seal.key)

    expect(result.kind).toBe('ok')
    // The redeem fetched the ciphertext from the TRUSTED origin, rebuilt from config, by ref only.
    expect(requests.map((r) => r.url)).toContain(`https://${ORIGIN}/c/${REF}/ciphertext`)
    for (const r of requests) {
      expect(r.url).not.toContain(seal.key)
      expect(r.url).not.toMatch(/[?&]k=/)
      expect(JSON.stringify(r.headers)).not.toContain(seal.key)
    }
    expect(logged.join('\n')).not.toContain(seal.key)
  })

  it('sends no voucher declaration header on any request of the link path (D9)', async () => {
    const seal = await sealed(buildPlainToken(MINT, 'sat', [4]))
    stub(seal)
    await fetchClaimSummary(REF)
    await redeemClaimRef(REF, seal.key)
    for (const r of requests) {
      expect(Object.keys(r.headers).filter((h) => /^x-cashu-voucher-redeem/i.test(h))).toEqual([])
    }
  })
})
