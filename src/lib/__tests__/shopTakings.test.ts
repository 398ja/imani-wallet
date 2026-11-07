import { readFileSync } from 'node:fs'

import type { TransactionRow } from '@imani/wallet-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #402 §4 step 4 / contract §5: after a checkout the online shop hands the stall its takings as
 * one NIP-17 token per voucher_id, each locked P2PK to the stall. Several such DMs for one order
 * must each file their own claim against their own issued row, carry the attestation, and name
 * the online-shop terminal. Harness as merchantClaim.test.ts: the real bridge and row builder.
 */
const STALL = 'f'.repeat(64)
const SHOP = 'e'.repeat(64)
const VA = '1d4410af-70f5-4c14-8606-519404684ea7'
const VB = '2e5521b0-81a6-4d25-9717-62a515795fb8'

const store = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  merchant: null as Record<string, unknown> | null,
  attested: [] as Array<Record<string, unknown>>,
  ls: new Map<string, string>(),
}))
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.ls.get(k) ?? null,
  setItem: (k: string, v: string) => void store.ls.set(k, v),
  removeItem: (k: string) => void store.ls.delete(k),
  clear: () => store.ls.clear(),
  key: (i: number) => [...store.ls.keys()][i] ?? null,
  get length() {
    return store.ls.size
  },
})
vi.mock('../arrivalToast', () => ({
  announceArrival: () => {},
  announceBundleArrival: async () => {},
  resumeBundleArrivals: () => {},
  stopBundleArrivals: () => {},
}))
// sonner touches the DOM at import; the held-coupon toast is its own module for that reason (#133 review).
vi.mock('../heldToast', () => ({ announceHeld: () => {} }))
vi.mock('../refusalToast', () => ({ announceRefusal: () => {} }))
vi.mock('../unsavedReceipt', () => ({ announceUnsaved: () => {}, resumeUnsavedReceipts: () => {}, listUnsavedReceipts: () => [], dropAcknowledgedReceipts: async () => 0 }))
vi.mock('../queuedToast', () => ({ announceQueued: () => {}, settleQueued: () => {} }))
vi.mock('../merchant', () => ({
  loadMerchant: () => store.merchant,
  // Owner rule 2026-10-13: the relay's answer for an account with no local stall record.
  merchantStatus: async () => 'customer',
}))
vi.mock('../attestation', () => ({
  attestRedemption: async (a: Record<string, unknown>) => (store.attested.push(a), null),
  nullifierFor: (t: string) => `nullifier-of:${t}`,
}))
vi.mock('../paymentReceipt', () => ({ postPaymentReceipt: async () => {} }))
vi.mock('../nap', () => ({ getSigner: () => ({ pubkey: STALL }) }))
vi.mock('../dmCrypto', () => ({
  createDmCryptoAdapter: () => ({}),
  toLegacyMetadata: (m: unknown) => m,
}))
vi.mock('../wallet', () => ({
  getWallet: () => ({}),
  notifyWalletChanged: () => {},
  recordReceiptByNullifier: async () => {},
  // What redemptionLedger reads for the ceiling: exactly what was written.
  listTransactions: async () => store.rows,
}))
// The real bridge, minus the script loading `legacyApi` does.
vi.mock('../legacyBridge', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  legacyApi: async () => {},
}))

let captured: { redemptionAdapter?: { redeem: (t: string, o?: unknown) => Promise<unknown> } } = {}
vi.mock('@imani/dm-poll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createDmPollService: (config: typeof captured) => {
    captured = config
    return { start: async () => {}, stop: () => {}, fetchRecentDms: async () => [] }
  },
}))

vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })

const { startDmPoll, stopDmPoll } = await import('../dmPoll')
const { _setReceivePacerForTests } = await import('../receivePacer')
_setReceivePacerForTests({ acquire: async () => {}, reset: () => {} })
const { installTokenIdFill } = await import('../legacyBridge')
const { toTransaction, buildIssueTransaction } = await import('../transactions')
const { issuedVoucher } = await import('../issuedVoucher')
const { recordTerminal } = await import('../terminalRoster')
const { TERMINAL_ROLES } = await import('../terminalRole')
const { handlerFor } = await import('../terminalAttribution')

const buildRow = new Function(
  readFileSync('shared/tokenRedemption.js', 'utf8') + '; return _buildReceiveTransactionRow;',
)() as (v: Record<string, unknown>, m?: Record<string, unknown>) => Record<string, unknown> | null

const issued = (voucherId: string, amount: number) =>
  buildIssueTransaction({
    voucherId,
    amount,
    unit: 'EUR',
    decimals: 2,
    recipientPubkey: 'c'.repeat(64),
    at: 1_700_000_000_000,
  }) as unknown as Record<string, unknown>

const verified = (voucherId: string, value: number, signed: number) => ({
  voucherId,
  issuerId: STALL,
  faceValue: value,
  faceUnit: 'EUR',
  faceDecimals: 2,
  validation: { signatureValid: true, legacyCanonical: false, signedFaceValue: signed, cappedAtFaceValue: false },
})

let swaps = 0
const redeem = vi.fn(async (_token: string, opts: { metadata?: Record<string, unknown> }) => {
  swaps += 1
  const voucher = {
    token_id: `tok-after-swap-${swaps}`,
    token: `cashuBfresh${swaps}`,
    voucher_id: crypto.randomUUID(),
    face_value: Number(opts.metadata?.faceValue ?? 0),
    face_unit: 'EUR',
    face_decimals: 2,
    issuer_id: STALL,
    correlation_id: opts.metadata?.correlation_id,
  }
  await window.walletStorageIntegration!.atomicallyWrite({ vouchers: [voucher], transactions: [] })
  return voucher
})

const txs = () => store.rows.map((r) => toTransaction(r as unknown as TransactionRow))
const record = (id: string) => issuedVoucher(txs(), id, { now: 1_700_000_000_000, stallPubkey: STALL })!

beforeEach(() => {
  stopDmPoll()
  swaps = 0
  store.rows = [issued(VA, 2000), issued(VB, 1500)]
  store.attested = []
  store.ls.clear()
  store.merchant = { pubkey: STALL, categories: [] }
  recordTerminal(STALL, {
    terminalPubkey: SHOP,
    name: 'shop.example',
    role: TERMINAL_ROLES.REDEEM_ONLY,
    enrolledAt: 1,
    status: 'in-service',
    shop: { url: 'https://shop.example', platform: 'woocommerce' },
  })
  ;(globalThis as unknown as Record<string, unknown>)._buildReceiveTransactionRow = buildRow
  vi.stubGlobal('window', {
    TokenRedemption: { redeem },
    walletStorageIntegration: {
      init: vi.fn(),
      atomicallyWrite: async (input: { transactions?: unknown[] }) => {
        store.rows.push(...((input.transactions ?? []) as Record<string, unknown>[]))
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  installTokenIdFill()
  startDmPoll(STALL)
})

const handIn = (meta: Record<string, unknown>, n: number, sender = SHOP) =>
  captured.redemptionAdapter!.redeem(`cashuB-order-42-part-${n}`, { metadata: meta, senderPubkey: sender })

describe('an online shop hands in one order as several vouchers (#402 contract §5)', () => {
  it('files one claim per voucher against its own issued row, attested, named for the shop', async () => {
    // One €25 order paid by a €20 coupon (in two settled outputs) and €5 of a €15 one.
    await handIn(verified(VA, 1200, 2000), 1)
    await handIn(verified(VB, 500, 1500), 2)
    await handIn(verified(VA, 800, 2000), 3)

    expect(record(VA).claimedMinor).toBe(2000)
    expect(record(VA).outstandingMinor).toBe(0)
    expect(record(VB).claimedMinor).toBe(500)
    expect(record(VB).outstandingMinor).toBe(1000)

    const claims = txs().filter((t) => t.direction === 'in')
    expect(claims.map((t) => t.voucherId)).toEqual([VA, VB, VA])
    expect(claims.every((t) => t.terminalPubkey === SHOP)).toBe(true)
    expect(handlerFor({ terminalPubkey: claims[0].terminalPubkey! }, STALL).label).toBe('shop.example')

    // Every hand-in carries its own kind-7377 attestation, over its own voucher's figure.
    expect(store.attested.map((a) => [a.token, a.faceValue, a.issuerId, a.signatureValid])).toEqual([
      ['cashuB-order-42-part-1', 1200, STALL, true],
      ['cashuB-order-42-part-2', 500, STALL, true],
      ['cashuB-order-42-part-3', 800, STALL, true],
    ])
  })

  it('does not let one voucher eat another\u2019s remainder, nor run past its own issue', async () => {
    await handIn(verified(VA, 2000, 2000), 1)
    await expect(handIn(verified(VA, 100, 2000), 2)).rejects.toThrow()
    expect(record(VB).claimedMinor).toBe(0)
  })

  it('names no terminal for a coupon from anyone else', async () => {
    await handIn(verified(VB, 300, 1500), 1, 'd'.repeat(64))
    const claim = txs().find((t) => t.direction === 'in')!
    expect(claim.voucherId).toBe(VB)
    expect(claim.terminalPubkey).toBeUndefined()
  })

  it('keeps the order each voucher was spent on, so a shop sale never reads only "Received via DM" (2026-11-02)', async () => {
    // One €5 order (59) paid by €3.90 of one voucher and €1.10 of another; then a €1 order (60).
    const order = (n: string, applied: number) => ({
      kind: 'online_shop',
      shopUrl: 'https://shop.example',
      shopHost: 'shop.example',
      platform: 'woocommerce',
      orderNumber: n,
      orderRef: `wc-order-${n}`,
      codeRef: '3d87b6f39cb5',
      amountApplied: applied,
    })
    await handIn({ ...verified(VB, 390, 1500), spendSource: order('59', 500) }, 1)
    await handIn({ ...verified(VA, 108, 2000), spendSource: order('59', 500) }, 2)
    await handIn({ ...verified(VA, 102, 2000), spendSource: order('60', 100) }, 3)

    const claims = txs().filter((t) => t.direction === 'in')
    expect(claims.map((t) => [t.voucherId, t.amount, t.spendSource?.orderNumber])).toEqual([
      [VB, 390, '59'],
      [VA, 108, '59'],
      [VA, 102, '60'],
    ])
    expect(claims[2].spendSource).toMatchObject({ shopHost: 'shop.example', codeRef: '3d87b6f39cb5', amountApplied: 100 })
    // Each voucher's own record shows its claims: none filed under the other.
    expect(record(VA).claimedMinor).toBe(210)
    expect(record(VB).claimedMinor).toBe(390)
  })

  it('drops a malformed order declaration rather than half-keeping it', async () => {
    await handIn({ ...verified(VB, 300, 1500), spendSource: { kind: 'online_shop', shopUrl: 'javascript:alert(1)' } }, 1)
    const claim = txs().find((t) => t.direction === 'in')!
    expect(claim.voucherId).toBe(VB)
    expect(claim.spendSource).toBeUndefined()
  })
})
