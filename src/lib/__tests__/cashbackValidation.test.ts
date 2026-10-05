import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { redeemCashbackCode } from '../cashback'
import { cashbackValidation, recheckCashbackRow } from '../cashbackValidation'
import { clearConfigCache } from '../config'
import { createDmCryptoAdapter } from '../dmCrypto'
import { warrantSaleDigest } from '../issuanceWarrant'
import { validationStatus } from '../validationStatus'
import { resetGate } from './trustedMintKit'
import { buildVoucherToken, dmEnvelope } from './voucherFixtures'

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
  resetGate()
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
  resetGate()
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
    // `http://mint.test` is the mint the voucher fixture stamps. Served as the
    // token mint so the backing gate on the commit (#133 review) lets these
    // through to the signature recording this suite is about.
    if (url.startsWith('/api/v1/config'))
      return json(200, { default_domain: 'x.test', cashback_origins: [ORIGIN], token_mint_urls: ['http://mint.test'] })
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

describe('the cashback record is the DM record (#156)', () => {
  const STALL_SK = hexToBytes('e'.repeat(63) + '5')
  const STALL = bytesToHex(schnorr.getPublicKey(STALL_SK))

  function warrantFor(total: number, unit = 'GBP', decimals = 2): string {
    const nonce = 'a'.repeat(32)
    return JSON.stringify({
      form: 'merchant',
      sale_total: total,
      face_decimals: decimals,
      unit,
      nonce,
      sig: bytesToHex(schnorr.sign(warrantSaleDigest(STALL, total, decimals, unit, nonce), STALL_SK)),
    })
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('writes exactly what the DM path writes for the same coupon', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', 'http://mint.test')
    const { token } = buildVoucherToken({ issuanceWarrant: warrantFor(1000) }, [1000, 782], {}, STALL_SK)
    const dm = createDmCryptoAdapter().parseTokenTransferMessage(dmEnvelope(token)) as Record<string, unknown>

    expect(dm.validation).toBeDefined()
    expect(cashbackValidation(token)).toEqual(dm.validation)
  })

  it('reads verified when the signature and the warrant both hold', () => {
    const { token } = buildVoucherToken({ issuanceWarrant: warrantFor(1000) }, [1000, 782], {}, STALL_SK)
    const v = cashbackValidation(token)

    expect(v).toMatchObject({ signatureValid: true, warrant: 'verified', warrantedSaleTotal: 1000 })
    expect(validationStatus(v)).toBe('verified')
  })

  it('fails a genuine coupon that carries no warrant, as the DM path does', () => {
    const v = cashbackValidation(buildVoucherToken().token)

    expect(v).toMatchObject({ signatureValid: true, warrant: 'absent' })
    expect(validationStatus(v)).toBe('failed')
  })

  it('records an issuer outside the allowlist as a failed signature', () => {
    vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', 'f'.repeat(64))
    const v = cashbackValidation(buildVoucherToken({ issuanceWarrant: warrantFor(1000) }, [1000, 782], {}, STALL_SK).token)

    expect(v).toMatchObject({ signatureValid: false })
    expect(validationStatus(v)).toBe('failed')
  })

  it('passes an issuer that IS on the allowlist', () => {
    vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', STALL)
    const v = cashbackValidation(buildVoucherToken({ issuanceWarrant: warrantFor(1000) }, [1000, 782], {}, STALL_SK).token)

    expect(validationStatus(v)).toBe('verified')
  })

  it('records nothing for plain ecash, which makes no issuer claim', () => {
    expect(cashbackValidation('cashuBnotavoucher')).toBeUndefined()
  })

  it('never throws, because it runs after the destructive claim', () => {
    expect(() => cashbackValidation(undefined as unknown as string)).not.toThrow()
  })
})

describe('the re-check on open leaves alone what it cannot help', () => {
  function ports(row: Record<string, unknown> | null, voucher: { token?: string; source_transport?: string } | null) {
    const updateTransaction = vi.fn(async () => undefined)
    return {
      updateTransaction,
      ports: { getTransaction: async () => row, getVoucher: async () => voucher, updateTransaction },
    }
  }

  it.each([
    ['a missing row', null, { token: 'x', source_transport: 'cashback' }],
    ['an outgoing row', { direction: 'out', tokenId: 't1' }, { token: 'x', source_transport: 'cashback' }],
    ['a row with no token id', { direction: 'in' }, { token: 'x', source_transport: 'cashback' }],
    ['a coupon since spent', { direction: 'in', tokenId: 't1' }, null],
    ['plain ecash by cashback', { direction: 'in', tokenId: 't1' }, { token: 'cashuBnotavoucher', source_transport: 'cashback' }],
  ])('%s', async (_name, row, voucher) => {
    const p = ports(row as Record<string, unknown> | null, voucher)

    expect(await recheckCashbackRow('x', p.ports)).toBe(false)
    expect(p.updateTransaction).not.toHaveBeenCalled()
  })

  it('swallows a storage failure', async () => {
    const p = ports({ direction: 'in', tokenId: 't1' }, null)
    p.ports.getVoucher = async () => {
      throw new Error('idb gone')
    }

    expect(await recheckCashbackRow('x', p.ports)).toBe(false)
  })
})
