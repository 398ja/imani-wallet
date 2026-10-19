import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

/**
 * Review rmo (mutants W10, W11): the gift paths of the owner rule of 2026-10-13, through giftLinks
 * itself. A merchant account never swaps another stall's gift, and never sends one by link (it
 * could not take it back). Nothing reaches the mint or the send.
 */

const h = vi.hoisted(() => ({
  account: '' as string,
  local: new Set<string>(),
  redeemed: [] as string[],
  sent: 0,
}))

vi.mock('../merchant', async (orig) => ({
  ...(await orig<typeof import('../merchant')>()),
  loadMerchant: (pubkey: string) => (h.local.has(pubkey) ? { pubkey, active: true } : null),
  merchantStatus: async () => 'customer',
}))
vi.mock('../nap', () => ({ getSigner: () => ({ pubkey: h.account }) }))
vi.mock('../wallet', () => ({
  getWallet: () => ({ getAllTransactions: async () => [], addTransaction: async (r: unknown) => r }),
  notifyWalletChanged: () => {},
}))
vi.mock('../txRecords', () => ({ publishTx: async () => {} }))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({}),
  withCorrelation: async (_ids: unknown, run: (id: string) => unknown) => run('corr'),
}))
vi.mock('../trustedMint', () => ({ loadTrustedMints: async () => {}, checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))
vi.mock('../pay', () => ({
  sendVouchers: async () => {
    h.sent += 1
    return { id: 's1', requested: 1, delivered: 1, parts: 1 }
  },
}))

const { redeemGiftTokens, sendGift } = await import('../giftLinks')
const { forgetAccountRoles } = await import('../merchantVouchers')
const { buildVoucherToken } = await import('./voucherFixtures')

const STALL_A = getPublicKey(generateSecretKey())
const STALL_B_KEY = generateSecretKey()
const STALL_B = getPublicKey(STALL_B_KEY)

beforeEach(() => {
  forgetAccountRoles()
  h.account = STALL_A
  h.local = new Set([STALL_A])
  h.redeemed = []
  h.sent = 0
  vi.stubGlobal('window', {
    location: { origin: 'https://wallet.example' },
    TokenRedemption: {
      redeem: async (token: string) => {
        h.redeemed.push(token)
        return {}
      },
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gift links under the merchant rule', () => {
  it('a merchant account does not swap another stall\u2019s gift', async () => {
    const { token } = buildVoucherToken({}, [8], {}, STALL_B_KEY)
    const out = await redeemGiftTokens([{ token, sentAt: 1_800_000_000 }], 'gift_link')
    expect(out).toEqual({ kind: 'merchant_refused', reason: 'merchant' })
    expect(h.redeemed).toEqual([])
  })

  it('a customer account takes the same gift', async () => {
    h.account = getPublicKey(generateSecretKey())
    const { token } = buildVoucherToken({}, [8], {}, STALL_B_KEY)
    const out = await redeemGiftTokens([{ token, sentAt: 1_800_000_000 }], 'gift_link')
    expect(out.kind).not.toBe('merchant_refused')
    expect(h.redeemed).toEqual([token])
  })

  it('a merchant account cannot send another stall\u2019s coupon by link', async () => {
    await expect(
      sendGift({ payer: STALL_A, merchant: { pubkey: STALL_B } as never, unit: 'EUR', amount: 1, x: 1_900_000_000 }),
    ).rejects.toThrow(/could not take it back/)
    expect(h.sent).toBe(0)
  })
})

describe('logging out (#331): no gift swap once logout has started', () => {
  it('is deferred before any swap, so the gift stays on its link', async () => {
    const gate = await import('../receiveGate')
    const { RECEIVE_PAUSED_MESSAGE } = await import('../giftLinks')
    h.account = getPublicKey(generateSecretKey())
    const { token } = buildVoucherToken({}, [8], {}, STALL_B_KEY)
    gate.closeReceives()
    try {
      const out = await redeemGiftTokens([{ token, sentAt: 1_800_000_000 }], 'gift_link')
      expect(out).toEqual({ kind: 'failed', message: RECEIVE_PAUSED_MESSAGE })
    } finally {
      gate.openReceives()
    }
    expect(h.redeemed).toEqual([])
    expect(RECEIVE_PAUSED_MESSAGE).not.toMatch(/nsec|npub|relay|nostr|\bNIP|token|mint/i)
  })
})
