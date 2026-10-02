import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { redeemCashbackCode } from '../cashback'
import { recheckCashbackRow } from '../cashbackValidation'
import { clearConfigCache } from '../config'
import { validationStatus } from '../validationStatus'
import { buildVoucherToken } from './voucherFixtures'

/**
 * #156: a cashback coupon never ran the issuer + signature check, so its row
 * carried no `validation` and the detail screen read "Issuer: Not checked".
 */

/** What each redeem registered with the bridge, which is what lands on its row. */
const registered: Array<Record<string, unknown>> = []

vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({}),
  withCorrelation: async (ids: Record<string, unknown>, run: (id: string) => unknown) => {
    registered.push(ids)
    return run('corr-test')
  },
}))
vi.mock('../wallet', () => ({
  notifyWalletChanged: () => {},
  recordCashbackStatus: async () => {},
}))
vi.mock('../nip98', () => ({
  signedFetch: async () => new Response('{}', { status: 200 }),
}))

const ORIGIN = 'cashback.example.test'
const CLAIM_REF = 'abcd1234efgh5678'
const store = new Map<string, string>()

beforeEach(() => {
  registered.length = 0
  clearConfigCache()
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('window', { TokenRedemption: { redeem: async () => ({}) } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Serve one sealed token through the by-code flow. */
async function serve(token: string) {
  const keyBytes = new Uint8Array(32).fill(0)
  const iv = new Uint8Array(12).fill(7)
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'])
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token))
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input)
    if (url.startsWith('/api/v1/config')) return json(200, { default_domain: 'x.test', cashback_origins: [ORIGIN] })
    if (url.includes('/cashback/by-code/'))
      return json(200, { claimUrl: `https://${ORIGIN}/c/${CLAIM_REF}#k=${b64url(keyBytes)}` })
    if (url.includes('/cashback/public/')) return json(200, { amountMinor: 500, unit: 'EUR' })
    if (url.includes('/ciphertext')) return json(200, { ciphertext: b64url(new Uint8Array(buf)), iv: b64url(iv) })
    throw new Error(`unexpected fetch: ${url}`)
  })
}

describe('cashback redeem records what it checked (#156)', () => {
  it('records a verified signature on a genuine coupon', async () => {
    const { token } = buildVoucherToken()
    await serve(token)

    const result = await redeemCashbackCode('CB-A1B2-C3')

    expect(result.kind).toBe('ok')
    const validation = registered[0]?.validation as Parameters<typeof validationStatus>[0]
    expect(validation).toMatchObject({ signatureValid: true, signedFaceValue: 1000 })
  })

  it('records a forged coupon as failed, never as verified or unchecked', async () => {
    const { token } = buildVoucherToken({}, [1000, 782], { faceValue: 10000 })
    await serve(token)

    await redeemCashbackCode('CB-A1B2-C3')

    const validation = registered[0]?.validation as Parameters<typeof validationStatus>[0]
    expect(validation).toMatchObject({ signatureValid: false })
    expect(validationStatus(validation)).toBe('failed')
  })

  it('records a missing signature as failed', async () => {
    const { token } = buildVoucherToken({}, [1000, 782], { issuerSignature: '' })
    await serve(token)

    await redeemCashbackCode('CB-A1B2-C3')

    expect(registered[0]?.validation).toMatchObject({ signatureValid: false })
  })
})

describe('re-checking a cashback row saved before #156', () => {
  function ports(row: Record<string, unknown>, voucher: { token?: string; source_transport?: string } | null) {
    const writes: Array<{ id: string; patch: Record<string, unknown> }> = []
    return {
      writes,
      ports: {
        getTransaction: async () => row,
        getVoucher: async () => voucher,
        updateTransaction: async (id: string, patch: Record<string, unknown>) => void writes.push({ id, patch }),
      },
    }
  }

  it('records a verified result on an unchecked cashback row', async () => {
    const { token } = buildVoucherToken()
    const p = ports({ direction: 'in', tokenId: 't1' }, { token, source_transport: 'cashback' })

    expect(await recheckCashbackRow('received:t1', p.ports)).toBe(true)
    expect(p.writes).toHaveLength(1)
    expect(p.writes[0].patch.validation).toMatchObject({ signatureValid: true })
  })

  it('records a forged one as failed', async () => {
    const { token } = buildVoucherToken({}, [1000, 782], { faceValue: 10000 })
    const p = ports({ direction: 'in', tokenId: 't1' }, { token, source_transport: 'cashback' })

    await recheckCashbackRow('received:t1', p.ports)
    expect(p.writes[0].patch.validation).toMatchObject({ signatureValid: false })
  })

  it('leaves rows that already carry a result, and rows from other paths', async () => {
    const { token } = buildVoucherToken()
    const checked = ports(
      { direction: 'in', tokenId: 't1', validation: { signatureValid: false } },
      { token, source_transport: 'cashback' },
    )
    const dm = ports({ direction: 'in', tokenId: 't1' }, { token, source_transport: 'sse' })

    expect(await recheckCashbackRow('x', checked.ports)).toBe(false)
    expect(await recheckCashbackRow('x', dm.ports)).toBe(false)
    expect(checked.writes).toHaveLength(0)
    expect(dm.writes).toHaveLength(0)
  })
})
