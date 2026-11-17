import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip17 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * A Cashlink that was never locked to its link (the legacy send, or an arm that did not take) and
 * is taken back, at its expiry or by hand, comes back through TokenRedemption. That receive's row is
 * rebuilt from empty metadata, so it read "Received via DM", in no bundle, with nothing tying it to
 * the link: the sender was told "its voucher came back to you" and History showed no take-back.
 * It now reads "Taken back from Cashlink", in the link's bundle, as the locked path's row does, and
 * names the `sent` row that made the Cashlink (`returnOf`), so the return opens the send.
 */

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  written: [] as Array<Record<string, unknown>>,
}))

vi.mock('../wallet', () => ({
  getWallet: () => ({
    getAllTransactions: async () => h.rows,
    updateTransaction: async (id: string, patch: Record<string, unknown>) => {
      const row = h.rows.find((r) => r.id === id)
      if (!row) return null
      Object.assign(row, patch)
      return row
    },
    addTransaction: async (row: Record<string, unknown>) => {
      h.rows.push(row)
      return row
    },
  }),
  notifyWalletChanged: () => {},
}))
vi.mock('../txRecords', () => ({ publishTx: async () => {} }))
vi.mock('../nap', () => ({
  getSigner: () => ({ withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(hexToBytes('33'.repeat(32))) }),
}))
vi.mock('../legacyBridge', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  legacyApi: async () => ({}),
}))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))

const { installTokenIdFill } = await import('../legacyBridge')
const { deriveLinkSecret, linkPubOf, secretToText } = await import('../giftLink')
const { reconcileGiftLinks, takeBack } = await import('../giftLinks')
const { cashlinkBundleId } = await import('../cashlinkFlow')
const { CASHLINK_TAKEN_BACK_MEMO } = await import('../transactions')
const { gatewayAnswers, resetGate } = await import('./trustedMintKit')
const { buildVoucherToken } = await import('./voucherFixtures')

const SOURCE = readFileSync(new URL('../../../shared/tokenRedemption.js', import.meta.url), 'utf8')
const ID = hexToBytes('33'.repeat(32))
const MINT = 'http://mint.test'
const store = new Map<string, string>()
const wrapTo = (linkPub: string, token: string, by = generateSecretKey()) =>
  nip17.wrapEvent(by, { publicKey: linkPub }, JSON.stringify({ type: 'cashu_token_transfer', token, sender_pubkey: getPublicKey(by) }))

beforeEach(async () => {
  store.clear()
  h.rows = []
  h.written = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  await gatewayAnswers(MINT)
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  // The vendored builder, as the page loads it: a classic-script global.
  ;(globalThis as unknown as Record<string, unknown>)._buildReceiveTransactionRow = new Function(
    `${SOURCE}; return _buildReceiveTransactionRow;`,
  )()
  vi.stubGlobal('window', {
    location: { origin: 'https://wallet.example' },
    walletStorageIntegration: {
      atomicallyWrite: async (input: { transactions?: Array<Record<string, unknown>> }) => void h.written.push(...(input.transactions ?? [])),
    },
    // What TokenRedemption does at the end of a receive: the swapped coupon, no token_id (storage.js
    // is never loaded), so `transactions: []` and the write hook rebuilds the row.
    TokenRedemption: {
      redeem: async (token: string, opts: { metadata?: Record<string, unknown> }) => {
        const voucher = { token: `${token}fresh`, voucher_id: 'gw-1', face_value: 8, face_unit: 'EUR', face_decimals: 2, correlation_id: opts.metadata?.correlation_id }
        await window.walletStorageIntegration!.atomicallyWrite({ vouchers: [voucher], transactions: [] })
        return voucher
      },
    },
  })
  installTokenIdFill()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetGate()
})

describe('an unlocked Cashlink taken back has its own History row', () => {
  const secret = deriveLinkSecret(ID, 3)
  const k = secretToText(secret)
  const bundleId = cashlinkBundleId(linkPubOf(secret))

  it('at its expiry: the reconcile takes it back and the row says so, in the link bundle', async () => {
    // Arrange
    const real = buildVoucherToken({ expiresAt: 0 }, [8]).token
    h.rows = [{ id: 'sent:g', type: 'sent', timestamp: 1, link: { k, x: 1_800_000_000, status: 'outstanding' } }]
    const wraps = [wrapTo(linkPubOf(secret), real)]
    vi.stubGlobal('fetch', async () => Response.json({ events: wraps }))

    // Act
    const out = await reconcileGiftLinks(1_800_000_001_000, async () => 'UNSPENT')

    // Assert
    expect(out).toEqual({ claimed: 0, reclaimed: 1 })
    expect(h.written).toHaveLength(1)
    expect(h.written[0]).toMatchObject({ type: 'received', direction: 'in', memo: CASHLINK_TAKEN_BACK_MEMO, bundleId, returnOf: 'sent:g' })
  })

  it('by hand: Take it back writes the same row', async () => {
    // Arrange
    const real = buildVoucherToken({ expiresAt: 0 }, [8]).token
    h.rows = [{ id: 'sent:h', type: 'sent', timestamp: 1, link: { k, x: 2_000_000_000, status: 'outstanding' } }]
    const wraps = [wrapTo(linkPubOf(secret), real)]
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('/v1/checkstate') ? Response.json({ states: [{ state: 'UNSPENT' }] }) : Response.json({ events: wraps }),
    )

    // Act
    const out = await takeBack(k)

    // Assert
    expect(out.kind).toBe('ok')
    expect(h.written).toHaveLength(1)
    expect(h.written[0]).toMatchObject({ type: 'received', direction: 'in', memo: CASHLINK_TAKEN_BACK_MEMO, bundleId, returnOf: 'sent:h' })
  })
})
