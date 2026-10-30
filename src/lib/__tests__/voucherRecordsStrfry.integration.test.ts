/**
 * @vitest-environment node
 *
 * #203 against a REAL strfry (maxEventSize 65,536), not a stub. Skipped unless
 * IMANI_STRFRY_URL is set, e.g. the local terminal gate's relay:
 *
 *   IMANI_STRFRY_URL=ws://127.0.0.1:28379 npx vitest run voucherRecordsStrfry
 *
 * Publishes the real 7-proof terminal coupon through the production relay.ts,
 * then restores it as a FRESH device would: a new key session, an empty store,
 * nothing but the relay.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey, nip44, type EventTemplate } from 'nostr-tools'
import WebSocket from 'ws'
import type { VoucherRow } from '@imani/wallet-storage'

const URL_ = process.env.IMANI_STRFRY_URL
;(globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket
vi.stubEnv('VITE_RELAY_URL', URL_ ?? 'ws://127.0.0.1:9')

const sk = crypto.getRandomValues(new Uint8Array(32))
const pk = getPublicKey(sk)
const key = nip44.getConversationKey(sk, pk)
vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: pk,
    nip44Encrypt: (_: string, p: string) => nip44.encrypt(p, key),
    nip44Decrypt: (_: string, c: string) => nip44.decrypt(c, key),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
  }),
}))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({ validateToken: async () => ({ state: 'UNSPENT' }) }),
}))
const store = vi.hoisted(() => ({ restored: [] as VoucherRow[] }))
vi.mock('../wallet', () => ({
  addRestoredVoucher: async (row: VoucherRow) => void store.restored.push(row),
  getWallet: () => ({ getAllVouchers: async () => [] }),
  notifyWalletChanged: () => undefined,
}))

describe.skipIf(!URL_)('coupon backup through a real strfry (#203)', () => {
  it('is accepted in full and a fresh device restores the 7-proof terminal coupon', async () => {
    const { publishVoucher, restoreVouchers, NIP60_TOKEN_KIND } = await import('../voucherRecords')
    const { allEvents } = await import('../relay')
    const token = readFileSync(new URL('./fixtures/terminal-coupon-7-proofs.txt', import.meta.url), 'utf8').trim()
    const coupon = {
      token_id: 'ef'.repeat(32),
      token,
      amount: 5405,
      face_value: 400,
      face_unit: 'EUR',
      face_decimals: 2,
      issuer_id: 'cd'.repeat(32),
      created_at: '2026-10-08T06:18:36.000Z',
      updated_at: '2026-10-08T06:18:36.000Z',
    } as VoucherRow

    const error = vi.spyOn(console, 'error')
    await publishVoucher(coupon)
    expect(error).not.toHaveBeenCalled()

    // The TEST checks strfry itself (the app reads only through the gateway since #428).
    const { SimplePool } = await import('nostr-tools')
    const pool = new SimplePool()
    const onRelay = await pool.querySync([URL_!], { authors: [pk], kinds: [NIP60_TOKEN_KIND] })
    pool.close([URL_!])
    console.log(
      '[#203] relay holds',
      onRelay.map((e) => ({ bytes: JSON.stringify(e).length, tags: e.tags.filter(([n]) => n !== 'payload_hash') })),
    )
    expect(onRelay.length).toBeGreaterThan(0)

    expect(await restoreVouchers(pk)).toBe(1)
    expect(store.restored[0]).toEqual(coupon)

    // Hand the key to the browser probe (e2e/probe-coupon-restore.mts), which
    // restores the same coupon in a fresh browser through the real app.
    if (process.env.IMANI_RESTORE_KEY_OUT) {
      const { writeFileSync } = await import('node:fs')
      const { nip19 } = await import('nostr-tools')
      writeFileSync(process.env.IMANI_RESTORE_KEY_OUT, nip19.nsecEncode(sk), { mode: 0o600 })
    }
  }, 30_000)
})
