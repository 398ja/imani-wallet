/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { VoucherRow } from '@imani/wallet-storage'

const stubs = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  notified: { count: 0 },
}))

vi.mock('../wallet', () => ({
  getWallet: () => ({
    getVoucher: async (id: string) => stubs.rows.get(id) ?? null,
    getAllVouchers: async () => [...stubs.rows.values()],
    saveVoucher: async (row: Record<string, unknown>) => {
      stubs.rows.set(String(row.token_id), row)
      return row
    },
  }),
  notifyWalletChanged: () => {
    stubs.notified.count += 1
  },
}))
// The fixtures carry no lock, so there is nothing to sign; kept off the key store.
vi.mock('../witness', () => ({ buildWitnesses: () => ({}) }))

import { createMintTransport } from '../mintTransport'
import { encodePlainTokenV4 } from '../plainToken'
import { receiveTokenByOwnSwap } from '../receiveToken'
import { loadSwapIntents } from '../swapIntent'
import { saveRecoveredSwapBack, swapBackToSats, SwapBackNotPossible } from '../swapBack'
import { isVoucherSecret, tokenProofs } from '../voucherToken'
import { resetGate } from './trustedMintKit'
import { buildVoucherToken } from './voucherFixtures'

/**
 * "Swap back to sats" (cashu-mint#540, design §2.13) and the D9 guard.
 *
 * D9: the wallet is never a crediting redeemer. It never sends `X-Cashu-Voucher-Redemption` or
 * `X-Cashu-Voucher-Redeemer`, so its swap back consumes none of a coupon's cap, and its ordinary
 * own-swap receive still refuses vouchers. Both halves are driven through the REAL HTTP transport
 * against a stubbed `fetch` that signs like a mint, so the headers asserted are the ones sent.
 */

const PUBKEY = 'a'.repeat(64)
const MINT = 'http://mint.test'
const KEYSET = '009a1f293253e41e'

/** A `fetch` that answers like a mint (real BDHKE), recording every request's headers. */
async function signingMint() {
  const { secp256k1 } = await import('@noble/curves/secp256k1.js')
  const { bytesToHex } = await import('@noble/hashes/utils')
  const scalar = BigInt('0x' + bytesToHex(secp256k1.utils.randomSecretKey()))
  const publicKey = secp256k1.Point.BASE.multiply(scalar).toHex(true)
  const keys: Record<string, string> = {}
  for (let a = 1; a <= 1024; a *= 2) keys[String(a)] = publicKey

  const requests: { url: string; headers: Record<string, string> }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    requests.push({ url, headers })
    if (url.endsWith('/v1/keysets')) {
      return Response.json({ keysets: [{ id: KEYSET, unit: 'sat', active: true }] })
    }
    if (url.endsWith(`/v1/keys/${KEYSET}`)) return Response.json({ keysets: [{ id: KEYSET, keys }] })
    if (url.endsWith('/v1/swap')) {
      const body = JSON.parse(String(init?.body)) as { outputs: { amount: number; id: string; B_: string }[] }
      return Response.json({
        signatures: body.outputs.map((o) => ({
          id: o.id,
          amount: o.amount,
          C_: secp256k1.Point.fromHex(o.B_).multiply(scalar).toHex(true),
        })),
      })
    }
    if (url.includes('/api/v1/config')) return Response.json({ nip05_domain: 'imani.test', mint_url: MINT })
    return new Response('not found', { status: 404 })
  })
  return { fetchMock, requests }
}

function couponRow(over: Partial<VoucherRow> = {}): VoucherRow {
  const { token } = buildVoucherToken({}, [8, 4], {}, undefined, true)
  return {
    token_id: 'row-1',
    voucher_id: '1d4410af-70f5-4c14-8606-519404684ea7',
    token,
    amount: 12,
    token_amount: 12,
    face_value: 1000,
    face_unit: 'GBP',
    status: 'fully_redeemed',
    created_at: '2026-10-10T00:00:00Z',
    updated_at: '2026-10-10T00:00:00Z',
    ...over,
  } as VoucherRow
}

beforeEach(() => {
  localStorage.clear()
  stubs.rows.clear()
  resetGate()
  vi.stubEnv('VITE_TRUSTED_MINT_URLS', MINT)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetGate()
})

describe('Swap back to sats', () => {
  it('turns a fully redeemed coupon into plain sats this wallet holds', async () => {
    const mint = await signingMint()
    vi.stubGlobal('fetch', mint.fetchMock)
    const row = couponRow()
    stubs.rows.set(row.token_id, row as unknown as Record<string, unknown>)

    const result = await swapBackToSats(row, PUBKEY, createMintTransport())

    expect(result.sats).toBe(12)
    const proofs = tokenProofs(result.token)
    expect(proofs.reduce((s, p) => s + p.amount, 0)).toBe(12)
    expect(proofs.every((p) => !isVoucherSecret(p.secret))).toBe(true)
    const saved = stubs.rows.get('row-1')!
    expect(saved.status).toBe('swapped_to_sats')
    expect(saved.sats_token).toBe(result.token)
    // Settled: nothing left for the recovery sweep.
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  })

  // D9: the swap back is the wallet's own swap. It declares nothing, so it consumes no cap.
  it('D9: sends no redemption declaration and no redeemer token on any request', async () => {
    const mint = await signingMint()
    vi.stubGlobal('fetch', mint.fetchMock)
    const row = couponRow()
    stubs.rows.set(row.token_id, row as unknown as Record<string, unknown>)

    await swapBackToSats(row, PUBKEY, createMintTransport())

    expect(mint.requests.some((r) => r.url.endsWith('/v1/swap'))).toBe(true)
    for (const request of mint.requests) {
      expect(Object.keys(request.headers)).not.toContain('x-cashu-voucher-redemption')
      expect(Object.keys(request.headers)).not.toContain('x-cashu-voucher-redeemer')
    }
  })

  it('only swaps back a coupon the mint refused as redeemed in full', async () => {
    const mint = await signingMint()
    vi.stubGlobal('fetch', mint.fetchMock)

    await expect(swapBackToSats(couponRow({ status: 'active' }), PUBKEY, createMintTransport())).rejects.toBeInstanceOf(
      SwapBackNotPossible,
    )
    expect(mint.requests).toEqual([])
  })

  it('refuses a coupon at a mint this build does not trust', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', 'https://other.mint.test')
    const mint = await signingMint()
    vi.stubGlobal('fetch', mint.fetchMock)

    await expect(swapBackToSats(couponRow(), PUBKEY, createMintTransport())).rejects.toThrow(/untrusted-mint/)
    expect(mint.requests).toEqual([])
  })

  // The page dies after the mint signed: the start-up sweep's proofs go back onto the coupon row.
  it('puts recovered proofs from an interrupted swap back onto its coupon', async () => {
    const row = couponRow({ swap_back_id: 'swap-xyz' } as Partial<VoucherRow>)
    stubs.rows.set(row.token_id, row as unknown as Record<string, unknown>)
    const proofs = [{ amount: 8, id: KEYSET, secret: 'ab'.repeat(32), C: '02' + 'cd'.repeat(32) }]

    expect(await saveRecoveredSwapBack({ swapId: 'swap-xyz', proofs })).toBe(true)
    expect(await saveRecoveredSwapBack({ swapId: 'not-a-swap-back', proofs })).toBe(false)
    expect(stubs.rows.get('row-1')!.status).toBe('swapped_to_sats')
    expect(stubs.rows.get('row-1')!.sats_amount).toBe(8)
  })
})

describe('D9: the wallet is never a crediting redeemer', () => {
  // The ordinary own-swap receive still refuses a voucher: only the explicit swap back may strip one.
  it('its own receive swap still refuses a voucher (voucher-unsupported)', async () => {
    const mint = await signingMint()
    vi.stubGlobal('fetch', mint.fetchMock)
    const { token } = buildVoucherToken({}, [8], {}, undefined, true)

    await expect(receiveTokenByOwnSwap(token, PUBKEY, createMintTransport())).rejects.toMatchObject({
      refusal: 'voucher-unsupported',
    })
    expect(mint.requests.filter((r) => r.url.endsWith('/v1/swap'))).toEqual([])
  })

  // No source the wallet ships sets either header. Comments may name them; code may not.
  it('no shipped source sets X-Cashu-Voucher-Redemption or X-Cashu-Voucher-Redeemer', () => {
    const roots = ['src', 'shared', 'packages', 'services'].map((d) => join(process.cwd(), d))
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          walk(path)
          continue
        }
        if (!/\.(ts|tsx|js|mjs)$/.test(name) || /\.test\./.test(name)) continue
        const code = readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
        if (/x-cashu-voucher-redeem|x-cashu-voucher-redemption/i.test(code)) offenders.push(path)
      }
    }
    roots.forEach(walk)
    expect(offenders).toEqual([])
  })
})

describe('encodePlainTokenV4', () => {
  it('round-trips through the reader the wallet uses', () => {
    const proofs = [
      { amount: 8, id: KEYSET, secret: 'ab'.repeat(32), C: '02' + 'cd'.repeat(32) },
      { amount: 300, id: KEYSET, secret: 'ef'.repeat(32), C: '03' + '12'.repeat(32) },
    ]
    const token = encodePlainTokenV4(MINT, 'sat', proofs)

    expect(token.startsWith('cashuB')).toBe(true)
    expect(tokenProofs(token)).toEqual(proofs)
  })
})
