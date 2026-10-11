import { beforeEach, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import type { VoucherRow } from '@imani/wallet-storage'

import { couponsFor, spendable, toMerchants, walletTotals } from '../merchants'
import { forgetCredentialParses, isTerminalCredential, terminalCredentialFromToken } from '../notMoney'
import { forgetLicenceParses } from '../licences'
import { buildLicenceVoucherToken, buildLockedCredentialToken, buildVoucherToken } from './voucherFixtures'

/**
 * The 1-sat terminal credential must never be money (#160, owner report on wallet 0.19.0).
 *
 * A personal wallet enrolled as a "terminal" received its credential and showed it as 1 sat in
 * its balance and as a coupon in the home carousel. Negative assertions on every money view, and
 * a forged "credential" that must stay money.
 */

const STALL_KEY = generateSecretKey()
const STALL = getPublicKey(STALL_KEY)
const DEVICE = getPublicKey(generateSecretKey())

let seq = 0
function rowOf(token: string, extra: Partial<VoucherRow> = {}): VoucherRow {
  seq += 1
  return {
    token_id: `id-${seq}`,
    token,
    amount: 1,
    face_value: 1,
    face_unit: 'sat',
    face_decimals: 0,
    token_amount: 1,
    issuer_id: STALL,
    status: 'active',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...extra,
  }
}

const credential = () => rowOf(buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE }))
const licence = () =>
  rowOf(
    buildLicenceVoucherToken({
      merchantMetadata: JSON.stringify({ subscription_id: 'sub_1', features: ['terminals'], lock_key: STALL }),
      faceValue: 4000,
      unit: 'GBP',
    }).token,
    { face_value: 4000, face_unit: 'GBP', face_decimals: 2, issuer_id: 'f'.repeat(64) },
  )
/** An ordinary 1-sat coupon from the same stall: real money, however small. */
const coupon = () => {
  const built = buildVoucherToken({ faceValue: 1, unit: 'sat', faceDecimals: 0 }, [1], {}, STALL_KEY)
  return rowOf(built.token)
}

beforeEach(() => {
  forgetCredentialParses()
  forgetLicenceParses()
})

describe('a terminal credential is not money', () => {
  it('is recognised from its signed metadata', () => {
    expect(isTerminalCredential(credential())).toBe(true)
    expect(isTerminalCredential(coupon())).toBe(false)
  })

  it('is excluded from the balance, while a 1-sat coupon still counts', () => {
    const rows = [credential(), coupon()]
    expect(spendable(rows)).toHaveLength(1)
    const totals = walletTotals(toMerchants(rows))
    expect(totals).toEqual([{ unit: 'SAT', decimals: 0, minor: 1 }])
  })

  it('leaves the home carousel with only the real coupon', () => {
    const real = coupon()
    const merchants = toMerchants([credential(), real])
    expect(merchants).toHaveLength(1)
    expect(merchants[0].voucherCount).toBe(1)
    expect(couponsFor([credential(), real], STALL).map((r) => r.token_id)).toEqual([real.token_id])
  })

  it('shows no merchant at all when the credential is all the wallet holds', () => {
    expect(toMerchants([credential()])).toEqual([])
    expect(walletTotals(toMerchants([credential()]))).toEqual([])
  })

  it('excludes a credential and a licence together, and keeps the coupon', () => {
    const real = coupon()
    const rows = [credential(), licence(), real]
    expect(spendable(rows).map((r) => r.token_id)).toEqual([real.token_id])
    expect(walletTotals(toMerchants(rows))).toEqual([{ unit: 'SAT', decimals: 0, minor: 1 }])
  })
})

describe('a voucher that only CLAIMS to be a credential stays money', () => {
  const metadata = JSON.stringify({ terminal: true, stall_pubkey: STALL, role: 'redeem-only', lock_key: DEVICE })

  it('a valuable voucher with credential metadata is still counted', () => {
    const token = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, faceValue: 500, unit: 'EUR' })
    expect(terminalCredentialFromToken(token)).toBeNull()
  })

  it('an unlocked coupon with credential metadata is still counted', () => {
    const { token } = buildVoucherToken({ merchantMetadata: metadata, faceValue: 1, unit: 'sat', faceDecimals: 0 }, [1], {}, STALL_KEY)
    expect(terminalCredentialFromToken(token)).toBeNull()
  })

  it('a credential locked to a different key than its metadata names is still counted', () => {
    const token = buildLockedCredentialToken({
      stallKey: STALL_KEY,
      devicePubkey: DEVICE,
      metadata: JSON.stringify({ terminal: true, stall_pubkey: STALL, role: 'redeem-only', lock_key: 'e'.repeat(64) }),
    })
    expect(terminalCredentialFromToken(token)).toBeNull()
  })

  it('a forged signature is still counted', () => {
    const { token } = buildVoucherToken(
      { faceValue: 1, unit: 'sat', faceDecimals: 0 },
      [1],
      { merchantMetadata: metadata },
      STALL_KEY,
    )
    expect(terminalCredentialFromToken(token)).toBeNull()
  })

  it('a memo saying "terminal credential" proves nothing', () => {
    const { token } = buildVoucherToken({ memo: 'Imani terminal credential', faceValue: 1, unit: 'sat', faceDecimals: 0 }, [1], {}, STALL_KEY)
    expect(terminalCredentialFromToken(token)).toBeNull()
  })
})
