/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils'
import type { LicenceGrant } from '@imani/licence'
import type { TransactionRow } from '@imani/wallet-storage'

import {
  adoptCatalog,
  assertWithinSalesLimit,
  catalogSignatureValid,
  countedSales,
  currentCatalog,
  forgetCatalog,
  refreshCatalog,
  salesPosition,
  checkSale,
  SalesLimitError,
  terminalLimit,
} from '../entitlement'
import type { LicenceStatus } from '../licenceStatus'

const NOW = 1_800_000_000
const DAY = 86_400
const SECRET = new Uint8Array(32).fill(7)
const ISSUER = bytesToHex(schnorr.getPublicKey(SECRET))

function sign(body: string, secret = SECRET) {
  return { body, signature: bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(body)), secret)) }
}

const catalogBody = (version: number, freeGbp: number) =>
  JSON.stringify({
    version,
    overshoot_pct: 10,
    tiers: { free: { features: [], limits: { sales: { period: 'lifetime', amounts: { GBP: freeGbp } }, terminals: 1 } } },
  })

function status(grants: LicenceGrant[]): LicenceStatus {
  return {
    decision: grants.length
      ? { granted: true, grant: grants[0], source: 'verified' }
      : { granted: false, reason: 'absent', detail: '' },
    licence: null,
    checkedAt: NOW,
    grants,
  }
}

const sale = (amount: number, at = NOW * 1000, unit = 'GBP'): TransactionRow =>
  ({ id: `issued:${amount}:${at}`, type: 'issued', direction: 'out', timestamp: at, amount, unit }) as TransactionRow

afterEach(() => forgetCatalog())

describe('the signed catalog', () => {
  it('verifies our BIP-340 signature over the exact body', () => {
    const signed = sign(catalogBody(2, 150_00))
    expect(catalogSignatureValid(signed, ISSUER)).toBe(true)
    expect(catalogSignatureValid({ ...signed, body: signed.body.replace('15000', '99999') }, ISSUER)).toBe(false)
    expect(catalogSignatureValid(sign(catalogBody(2, 150_00), new Uint8Array(32).fill(9)), ISSUER)).toBe(false)
  })

  it('refuses every catalog when no issuer key is configured', () => {
    expect(catalogSignatureValid(sign(catalogBody(2, 1)), '')).toBe(false)
    expect(adoptCatalog(sign(catalogBody(2, 1)))).toBe(false)
    expect(currentCatalog().version).toBe(1)
  })

  it('ignores a catalog written into storage that we did not sign', () => {
    localStorage.setItem('imani.tiers.catalog', JSON.stringify({ body: catalogBody(9, 10 ** 9), signature: '00'.repeat(64) }))
    expect(currentCatalog().version).toBe(1)
  })
})

describe('the sales meter, from the ledger', () => {
  it('counts issued rows only, in seconds, and skips other kinds', () => {
    const rows = [sale(40_00), { ...sale(5_00), type: 'cashback' } as TransactionRow, sale(10_00, NOW)]
    expect(countedSales(rows)).toEqual([
      { at: NOW, amount: 40_00, currency: 'GBP' },
      { at: NOW, amount: 10_00, currency: 'GBP' },
    ])
  })

  it('refuses a free stall past 100 + 10 %, and lets it finish inside the margin', () => {
    const pos = salesPosition(status([]), 'GBP', [sale(95_00)])
    expect(pos.used).toBe(95_00)
    expect(checkSale(pos, 15_00).allowed).toBe(true)
    expect(checkSale(pos, 16_00).allowed).toBe(false)
  })

  it('lifts a free stall that received a 200 grant', () => {
    const grant: LicenceGrant = {
      features: [],
      pilot: false,
      expiresAt: NOW + 30 * DAY,
      validFrom: NOW - DAY,
      limits: { sales: { period: 'window', amounts: { GBP: 200_00 } } },
    }
    // Sales from before the grant opened do not count against it: its period is its own window.
    const pos = salesPosition(status([grant]), 'GBP', [sale(100_00, (NOW - 2 * DAY) * 1000), sale(50_00)])
    expect(pos.used).toBe(50_00)
    expect(checkSale(pos, 150_00).allowed).toBe(true)
  })
})

describe('the owner-side gate', () => {
  const deps = (rows: TransactionRow[], enforced = true) => ({
    status: async () => status([]),
    transactions: async () => rows,
    enforced,
  })

  it('throws SalesLimitError before minting when over the allowance', async () => {
    await expect(assertWithinSalesLimit({ stallPubkey: 'x', currency: 'GBP', amount: 20_00 }, deps([sale(100_00)]))).rejects.toBeInstanceOf(
      SalesLimitError,
    )
  })

  it('does nothing while enforcement is off', async () => {
    await expect(assertWithinSalesLimit({ stallPubkey: 'x', currency: 'GBP', amount: 10 ** 9 }, deps([], false))).resolves.toBeUndefined()
  })

  it('fails open when the wallet cannot be read', async () => {
    await expect(
      assertWithinSalesLimit(
        { stallPubkey: 'x', currency: 'GBP', amount: 10 ** 9 },
        { status: async () => status([]), transactions: async () => Promise.reject(new Error('idb')), enforced: true },
      ),
    ).resolves.toBeUndefined()
  })
})

describe('terminals from the tier', () => {
  it('is 1 free, 3 on Basic, unlimited on Pro and on a licence sold before tiers', () => {
    const g = (over: Partial<LicenceGrant>): LicenceGrant => ({ features: ['terminals'], pilot: false, expiresAt: NOW + DAY, ...over })
    expect(terminalLimit(status([]))).toBe(1)
    expect(terminalLimit(status([g({ tier: 'basic' })]))).toBe(3)
    expect(terminalLimit(status([g({ tier: 'pro' })]))).toBeNull()
    expect(terminalLimit(status([g({})]))).toBeNull()
  })
})

describe('fetching the published catalog', () => {
  it('adopts a newer signed catalog from the site, and ignores a bad answer', async () => {
    vi.stubEnv('VITE_LICENCE_SELLER_PUBKEY', ISSUER)
    const good = sign(catalogBody(3, 150_00))
    const ok = await refreshCatalog(async () => new Response(JSON.stringify(good), { status: 200 }))
    expect(ok).toBe(true)
    expect(currentCatalog().version).toBe(3)
    expect(await refreshCatalog(async () => new Response('nope', { status: 502 }))).toBe(false)
    expect(await refreshCatalog(async () => { throw new Error('offline') })).toBe(false)
    expect(currentCatalog().version).toBe(3)
    vi.unstubAllEnvs()
  })
})
