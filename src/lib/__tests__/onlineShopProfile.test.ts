/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { advertisedShop, reconcileOnlineShop, syncOnlineShop } from '../onlineShopProfile'
import { emptyMerchant, loadMerchant, mergeMerchantEvent, saveMerchant } from '../merchant'
import { TERMINAL_ROLES } from '../terminalRole'
import type { TerminalRecord } from '../terminalRoster'

const STALL = 'a'.repeat(64)
const S = 'b'.repeat(64)
const shopRow = (over: Partial<TerminalRecord> = {}): TerminalRecord => ({
  terminalPubkey: S,
  name: 'shop.example',
  role: TERMINAL_ROLES.REDEEM_ONLY,
  enrolledAt: 1_767_000_000_000,
  status: 'in-service',
  shop: { url: 'https://shop.example', platform: 'woocommerce' },
  ...over,
})

beforeEach(() => localStorage.clear())

describe('online_shop follows the roster (#402 §0)', () => {
  it('advertises a live shop, and not a waiting, revoked or ordinary till', () => {
    expect(advertisedShop([shopRow()])).toEqual({ url: 'https://shop.example', redeemKey: S, platform: 'woocommerce', since: 1_767_000_000 })
    expect(advertisedShop([shopRow({ status: 'waiting' })])).toBeNull()
    expect(advertisedShop([shopRow({ revokedAt: 1 })])).toBeNull()
    expect(advertisedShop([shopRow({ shop: undefined })])).toBeNull()
  })

  it('withdraws the field on revoke and keeps every other field', () => {
    const merchant = { ...emptyMerchant(STALL), acceptsCards: true, location: 'Market', onlineShop: advertisedShop([shopRow()])! }
    const change = reconcileOnlineShop(merchant, [shopRow({ revokedAt: 5 })])
    expect(change.kind).toBe('republish')
    if (change.kind !== 'republish') return
    expect(change.merchant.onlineShop).toBeUndefined()
    expect(change.merchant.acceptsCards).toBe(true)
    expect(change.merchant.location).toBe('Market')
    expect(reconcileOnlineShop(change.merchant, [shopRow({ revokedAt: 5 })]).kind).toBe('unchanged')
  })

  it('publishes a record a wallet reads the shop back from', async () => {
    saveMerchant({ ...emptyMerchant(STALL), acceptsCards: true })
    const sent: Array<{ content: string; created_at: number }> = []
    const out = await syncOnlineShop(STALL, [shopRow()], {
      sign: async (t) => ({ ...t, created_at: 100 }),
      publish: async (e) => (sent.push(e as never), { ok: 1 }),
    })
    expect(out).toEqual({ changed: true, published: true })
    const read = mergeMerchantEvent(emptyMerchant(STALL), sent[0].content, 100)
    expect(read.onlineShop?.redeemKey).toBe(S)
    expect(read.acceptsCards).toBe(true)
    expect(loadMerchant(STALL)?.onlineShop?.redeemKey).toBe(S)
    // Nothing changed: nothing published again.
    expect((await syncOnlineShop(STALL, [shopRow()], { sign: async () => { throw new Error('no') }, publish: async () => ({ ok: 0 }) })).changed).toBe(false)
  })

  it('retries a publish that never landed, on the next render, until one does', async () => {
    saveMerchant({ ...emptyMerchant(STALL), acceptsCards: true })
    const lost = await syncOnlineShop(STALL, [shopRow()], { sign: async (t) => ({ ...t, created_at: 100 }), publish: async () => ({ ok: 0 }) })
    expect(lost).toEqual({ changed: true, published: false })
    // Saved locally already, so reconcile says unchanged: it must still send.
    const sent: string[] = []
    const retry = await syncOnlineShop(STALL, [shopRow()], {
      sign: async (t) => ({ ...t, created_at: 101 }),
      publish: async (e) => (sent.push((e as { content: string }).content), { ok: 1 }),
    })
    expect(retry.published).toBe(true)
    expect(mergeMerchantEvent(emptyMerchant(STALL), sent[0], 101).onlineShop?.redeemKey).toBe(S)
    // Confirmed now: the next render sends nothing.
    let calls = 0
    await syncOnlineShop(STALL, [shopRow()], { sign: async (t) => (calls++, { ...t, created_at: 102 }), publish: async () => ({ ok: 1 }) })
    expect(calls).toBe(0)
  })
})
