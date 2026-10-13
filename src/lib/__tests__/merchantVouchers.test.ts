import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

/**
 * Owner rule 2026-10-13: a merchant account takes only its own stall's vouchers. The wallet's half:
 * refused before anything is spent. One row of the PR's matrix per case.
 */

const h = vi.hoisted(() => ({
  status: 'customer' as 'merchant' | 'customer' | 'unknown',
  asked: 0,
  local: new Set<string>(),
}))

vi.mock('../merchant', () => ({
  merchantStatus: async () => {
    h.asked += 1
    return h.status
  },
  loadMerchant: (pubkey: string) => (h.local.has(pubkey) ? { pubkey, active: true } : null),
}))

const {
  ForeignVoucherRefusedError,
  MERCHANT_FOREIGN_VOUCHER,
  forgetAccountRoles,
  isServerForeignRefusal,
  refuseForeignIssuer,
  refuseForeignVouchers,
  stallOfToken,
} = await import('../merchantVouchers')
const { buildLicenceVoucherToken, buildLockedCredentialToken, buildPlainToken, buildVoucherToken } = await import(
  './voucherFixtures'
)

const STALL_A_KEY = generateSecretKey()
const STALL_A = getPublicKey(STALL_A_KEY)
const STALL_B_KEY = generateSecretKey()
const CUSTOMER = getPublicKey(generateSecretKey())

const ownCoupon = () => buildVoucherToken({}, [8], {}, STALL_A_KEY).token
const foreignCoupon = () => buildVoucherToken({}, [8], {}, STALL_B_KEY).token

beforeEach(() => {
  forgetAccountRoles()
  h.status = 'customer'
  h.asked = 0
  h.local.clear()
})

describe('refuseForeignVouchers', () => {
  it('refuses a merchant another stall\u2019s voucher, with the copy', async () => {
    h.local.add(STALL_A)
    const refused = refuseForeignVouchers([foreignCoupon()], STALL_A)
    await expect(refused).rejects.toBeInstanceOf(ForeignVoucherRefusedError)
    await expect(refuseForeignVouchers([foreignCoupon()], STALL_A)).rejects.toThrow(MERCHANT_FOREIGN_VOUCHER)
  })

  it('refuses a merchant known only from the relay (another device of the stall)', async () => {
    h.status = 'merchant'
    await expect(refuseForeignVouchers([foreignCoupon()], STALL_A)).rejects.toMatchObject({ reason: 'merchant' })
  })

  it('accepts a merchant\u2019s own voucher (the till Sell flow) without asking the relay', async () => {
    h.local.add(STALL_A)
    h.status = 'unknown'
    await expect(refuseForeignVouchers([ownCoupon(), ownCoupon()], STALL_A)).resolves.toBeUndefined()
    expect(h.asked).toBe(0)
  })

  it('accepts a licence and a terminal credential (not money)', async () => {
    h.local.add(STALL_A)
    const licence = buildLicenceVoucherToken({
      merchantMetadata: JSON.stringify({ subscription_id: 'sub_1', features: ['terminals'], lock_key: STALL_A }),
    }).token
    const credential = buildLockedCredentialToken({ stallKey: STALL_A_KEY, devicePubkey: getPublicKey(generateSecretKey()) })
    await expect(refuseForeignVouchers([licence, credential], STALL_A)).resolves.toBeUndefined()
  })

  it('leaves a customer unchanged', async () => {
    h.status = 'customer'
    await expect(refuseForeignVouchers([foreignCoupon()], CUSTOMER)).resolves.toBeUndefined()
  })

  it('refuses a foreign voucher when the role is unknown (fail closed)', async () => {
    h.status = 'unknown'
    await expect(refuseForeignVouchers([foreignCoupon()], CUSTOMER)).rejects.toMatchObject({ reason: 'unknown' })
  })

  it('accepts an own voucher when the role is unknown', async () => {
    h.status = 'unknown'
    await expect(refuseForeignVouchers([ownCoupon()], STALL_A)).resolves.toBeUndefined()
  })

  it('treats a forged voucher naming the merchant as foreign', async () => {
    h.local.add(STALL_A)
    const forged = buildVoucherToken({}, [8], { faceValue: 99999 }, STALL_A_KEY).token
    expect(stallOfToken(forged)).toBe('unverified')
    await expect(refuseForeignVouchers([forged], STALL_A)).rejects.toBeInstanceOf(ForeignVoucherRefusedError)
  })

  it('never asks about plain ecash', async () => {
    h.status = 'unknown'
    await expect(refuseForeignVouchers([buildPlainToken('http://mint.test')], STALL_A)).resolves.toBeUndefined()
    expect(h.asked).toBe(0)
  })
})

describe('refuseForeignIssuer (before a destructive claim)', () => {
  it('refuses a merchant another stall\u2019s issuer, and passes its own and an unnamed one', async () => {
    h.local.add(STALL_A)
    await expect(refuseForeignIssuer(getPublicKey(STALL_B_KEY), STALL_A)).rejects.toMatchObject({ reason: 'merchant' })
    await expect(refuseForeignIssuer(STALL_A.toUpperCase(), STALL_A)).resolves.toBeUndefined()
    await expect(refuseForeignIssuer(null, STALL_A)).resolves.toBeUndefined()
  })
})

describe('accountRole cache', () => {
  it('keeps a customer answer briefly, never a merchant or unknown one', async () => {
    const { accountRole } = await import('../merchantVouchers')
    h.status = 'customer'
    await accountRole(CUSTOMER)
    await accountRole(CUSTOMER)
    expect(h.asked).toBe(1)
    h.status = 'unknown'
    forgetAccountRoles()
    await accountRole(CUSTOMER)
    await accountRole(CUSTOMER)
    expect(h.asked).toBe(3)
  })
})

describe('isServerForeignRefusal', () => {
  it('reads the server code from api.js errors', () => {
    expect(isServerForeignRefusal({ code: 'FOREIGN_VOUCHER_FOR_MERCHANT' })).toBe(true)
    expect(isServerForeignRefusal(new Error('HTTP 403 FOREIGN_VOUCHER_FOR_MERCHANT'))).toBe(true)
    expect(isServerForeignRefusal(new Error('already spent'))).toBe(false)
  })
})
