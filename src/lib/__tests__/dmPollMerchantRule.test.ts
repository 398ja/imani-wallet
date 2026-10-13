import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RedemptionRefusedError } from '@imani/dm-poll'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

/**
 * Owner rule 2026-10-13 on the DM path: a merchant account takes only its own stall's vouchers.
 * `refuseIfAnotherStalls` already refuses a verified foreign coupon on a device holding the stall
 * record; `refuseForeignForMerchant` covers the rest before the swap.
 */

const h = vi.hoisted(() => ({ local: false, relay: 'customer' as 'merchant' | 'customer' | 'unknown' }))

vi.mock('../merchant', async (orig) => ({
  ...(await orig<typeof import('../merchant')>()),
  loadMerchant: () => (h.local ? { pubkey: 'x', active: true } : null),
  merchantStatus: async () => h.relay,
}))
vi.mock('../wallet', () => ({ listTransactions: async () => [], getWallet: () => ({}), notifyWalletChanged: () => {} }))
vi.mock('../legacyBridge', () => ({ legacyApi: async () => ({}), withCorrelation: vi.fn() }))

const { refuseForeignForMerchant } = await import('../dmPoll')
const { forgetAccountRoles } = await import('../merchantVouchers')
const { buildVoucherToken } = await import('./voucherFixtures')

const A_KEY = generateSecretKey()
const A = getPublicKey(A_KEY)
const B_KEY = generateSecretKey()

beforeEach(() => {
  forgetAccountRoles()
  h.local = false
  h.relay = 'customer'
})

describe('refuseForeignForMerchant', () => {
  it('refuses, terminally, a stall known only from the relay that receives another stall\u2019s coupon', async () => {
    h.relay = 'merchant'
    const token = buildVoucherToken({}, [8], {}, B_KEY).token
    const refusal = refuseForeignForMerchant({ voucherId: 'v1' }, A, token)
    await expect(refusal).rejects.toBeInstanceOf(RedemptionRefusedError)
    await expect(refuseForeignForMerchant({ voucherId: 'v1' }, A, token)).rejects.toMatchObject({ reason: 'another-stall' })
  })

  it('takes the stall\u2019s own coupon home (the till Sell flow), relay down or not', async () => {
    h.local = true
    h.relay = 'unknown'
    await expect(refuseForeignForMerchant({}, A, buildVoucherToken({}, [8], {}, A_KEY).token)).resolves.toBeUndefined()
  })

  it('leaves a customer unchanged', async () => {
    await expect(refuseForeignForMerchant({}, A, buildVoucherToken({}, [8], {}, B_KEY).token)).resolves.toBeUndefined()
  })

  it('an unknown role on a foreign coupon is a retryable (non-terminal) refusal', async () => {
    h.relay = 'unknown'
    const refusal = refuseForeignForMerchant({}, A, buildVoucherToken({}, [8], {}, B_KEY).token)
    await expect(refusal).rejects.toThrow(/could not check this account/i)
    await expect(refuseForeignForMerchant({}, A, buildVoucherToken({}, [8], {}, B_KEY).token)).rejects.not.toBeInstanceOf(
      RedemptionRefusedError,
    )
  })
})
