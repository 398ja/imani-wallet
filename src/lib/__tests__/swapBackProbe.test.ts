/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * "Swap back to sats" against a REAL mint (cashu-mint#540 phase 2 gate). Skipped unless
 * PROBE_SWAPBACK_TOKEN names a file holding a coupon token at PROBE_SWAPBACK_MINT:
 *
 *   PROBE_SWAPBACK_MINT=https://mint.gate.localhost:38462 PROBE_SWAPBACK_TOKEN=/path/swapback.token \
 *   NODE_EXTRA_CA_CERTS=/path/mint.crt npx vitest run src/lib/__tests__/swapBackProbe.test.ts
 *
 * Runs the wallet's own swapBackToSats over the real mintTransport, recording every request's
 * headers: neither declaration header may appear. The gate driver then proves the coupon's cap
 * was untouched (its full value still credits to its stall).
 */
const live = process.env.PROBE_SWAPBACK_TOKEN ? describe : describe.skip

const rows = new Map<string, Record<string, unknown>>()
vi.mock('../wallet', () => ({
  getWallet: () => ({
    getVoucher: async (id: string) => rows.get(id) ?? null,
    getAllVouchers: async () => [...rows.values()],
    saveVoucher: async (row: Record<string, unknown>) => {
      rows.set(String(row.token_id), row)
      return row
    },
  }),
  notifyWalletChanged: () => {},
}))
vi.mock('../witness', () => ({ buildWitnesses: () => ({}) }))

live('swap back to sats against a real mint', () => {
  it('swaps the coupon into plain sats and sends no declaration header', async () => {
    const mint = process.env.PROBE_SWAPBACK_MINT!
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', mint)
    // Node, not jsdom: the real fetch must accept the transport's AbortSignal. The intent store
    // is localStorage, so a minimal one is provided.
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    const token = readFileSync(process.env.PROBE_SWAPBACK_TOKEN!, 'utf8').trim()
    const sent: Record<string, string>[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const h: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => (h[k.toLowerCase()] = v))
      sent.push({ url, ...h })
      return realFetch(url, init)
    })
    const { swapBackToSats } = await import('../swapBack')
    const { createMintTransport } = await import('../mintTransport')
    const { tokenProofs, isVoucherSecret } = await import('../voucherToken')
    const row = {
      token_id: 'probe-row',
      voucher_id: 'probe',
      token,
      amount: 10,
      status: 'fully_redeemed',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    rows.set(row.token_id, row)

    const result = await swapBackToSats(row as never, 'b'.repeat(64), createMintTransport())

    console.log(`swap back: ${result.sats} sats, ${sent.length} mint requests`)
    expect(result.sats).toBe(10)
    expect(tokenProofs(result.token).every((p) => !isVoucherSecret(p.secret))).toBe(true)
    expect(sent.some((r) => r.url.endsWith('/v1/swap'))).toBe(true)
    for (const r of sent) {
      expect(Object.keys(r)).not.toContain('x-cashu-voucher-redemption')
      expect(Object.keys(r)).not.toContain('x-cashu-voucher-redeemer')
    }
    expect(rows.get('probe-row')!.status).toBe('swapped_to_sats')
  })
})
