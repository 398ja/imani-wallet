/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../relay', () => ({ publish: async () => ({ ok: 0, errors: [] }), newestAddressable: async () => null }))
vi.mock('../transferSignature', () => ({ mirrorToGateway: async () => false }))
vi.mock('../nap', () => ({ getSigner: () => ({}) }))

const { startOnlineShopSync, stopOnlineShopSync } = await import('../onlineShopPublisher')
const { emptyMerchant, mergeMerchantEvent, saveMerchant } = await import('../merchant')
const { markInService, recordTerminal } = await import('../terminalRoster')
const { TERMINAL_ROLES } = await import('../terminalRole')

const STALL = 'a'.repeat(64)
const S = 'b'.repeat(64)

beforeEach(() => localStorage.clear())
afterEach(() => stopOnlineShopSync())

describe('online_shop follows the roster from any screen (#402)', () => {
  it('republishes when the shop row turns In service with Terminals closed', async () => {
    saveMerchant({ ...emptyMerchant(STALL), location: 'Market' })
    recordTerminal(STALL, {
      terminalPubkey: S,
      name: 'Web Shop',
      role: TERMINAL_ROLES.REDEEM_ONLY,
      enrolledAt: 1_767_000_000_000,
      status: 'waiting',
      voucherId: 'v1',
      shop: { url: 'https://shop.example', platform: 'woocommerce' },
    })
    const sent: Array<{ content: string }> = []
    startOnlineShopSync(STALL, {
      sign: async (t) => ({ ...t, created_at: 100 }),
      publish: async (e) => (sent.push(e as never), { ok: 1 }),
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(sent).toHaveLength(0)

    // What the DM poll's collector does when the shop's "enrolled" notice arrives.
    expect(markInService(STALL, S, 'v1')).toBe(true)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const read = mergeMerchantEvent(emptyMerchant(STALL), sent[0].content, 100)
    expect(read.onlineShop?.redeemKey).toBe(S)
    expect(read.location).toBe('Market')
  })
})
