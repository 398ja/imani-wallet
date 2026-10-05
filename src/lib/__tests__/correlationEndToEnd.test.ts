import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Review of #145 (snail 1): the correlation id, end to end.
 *
 * Driven through every piece that touches it, none of them doubled: dm-poll's
 * redemption adapter (which hands the id to the redeem), the REAL vendored
 * `TokenRedemption` (whose `buildVoucher` and `consolidateVoucher` carry it
 * onto the voucher row) and the REAL write hook (which stamps by it and strips
 * it before storage). Only the gateway is faked, at `api.receive`.
 *
 * Two coupons of two different vouchers are redeemed at once, the staging
 * shape: 206 sats of 19c4fed1 and 1365 sats of another voucher. Each row must
 * carry its own coupon's claim.
 */

const STALL = 'f'.repeat(64)
const VOUCHER_A = '19c4fed1-0000-4000-8000-000000000001'
const VOUCHER_B = 'b0b0b0b0-0000-4000-8000-000000000002'

const store = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  vouchers: [] as Record<string, unknown>[],
}))

vi.mock('../arrivalToast', () => ({
  announceArrival: () => {},
  announceBundleArrival: async () => {},
  resumeBundleArrivals: () => {},
  stopBundleArrivals: () => {},
}))
// sonner touches the DOM at import; the held-coupon toast is its own module for that reason (#133 review).
vi.mock('../heldToast', () => ({ announceHeld: () => {} }))
vi.mock('../refusalToast', () => ({ announceRefusal: () => {}, REFUSAL_MESSAGES: {} }))
vi.mock('../queuedToast', () => ({ announceQueued: () => {}, settleQueued: () => {} }))
vi.mock('../merchant', () => ({ loadMerchant: () => ({ pubkey: STALL, categories: [] }) }))
vi.mock('../attestation', () => ({
  attestRedemption: async () => null,
  nullifierFor: (t: string) => `nullifier-of:${t.slice(-12)}`,
}))
vi.mock('../paymentReceipt', () => ({ postPaymentReceipt: async () => {} }))
vi.mock('../nap', () => ({ getSigner: () => ({ pubkey: STALL }) }))
vi.mock('../dmCrypto', () => ({
  createDmCryptoAdapter: () => ({}),
  toLegacyMetadata: (m: Record<string, unknown>) => ({ ...m, issuer_id: m.issuerId, face_value: m.faceValue, face_unit: m.faceUnit }),
}))
vi.mock('../wallet', () => ({
  getWallet: () => ({}),
  notifyWalletChanged: () => {},
  recordReceiptByNullifier: async () => {},
  listTransactions: async () => store.rows,
  listVouchers: async () => store.vouchers,
}))
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
const { buildIssueTransaction } = await import('../transactions')
const { buildVoucherToken } = await import('./voucherFixtures')

const SOURCE = readFileSync('shared/tokenRedemption.js', 'utf8')

/** A gate per receive, so the test decides which write lands first. */
const gates = new Map<string, { open: () => void; opened: Promise<void> }>()
const gateFor = (token: string) => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  gates.set(token, { open, opened })
}

/**
 * The real vendored coordinator, its free globals supplied. `change` makes the
 * receive answer with a change token, which takes the `consolidateVoucher`
 * branch.
 */
function loadTokenRedemption(change: ReadonlySet<string>) {
  const api = {
    _nostrPublicKey: STALL,
    receive: async (token: string) => {
      await gates.get(token)?.opened
      const fresh = `cashuBfresh-${token.slice(-16)}`
      return change.has(token)
        ? { receive_id: `r-${token.slice(-8)}`, amount: 1, change_token: fresh, imported_count: 1, unit: 'sat' }
        : { receive_id: `r-${token.slice(-8)}`, amount: 1, token: fresh, imported_count: 1, unit: 'sat' }
    },
    acknowledgeReceive: async () => {},
    inspectVoucher: async () => ({}),
  }
  const memory = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  }
  return new Function(
    'api',
    'walletStorageIntegration',
    'localStorage',
    'resolveDecimals',
    `${SOURCE}; return TokenRedemption;`,
  )(api, window.walletStorageIntegration, localStorage, () => 2)
}

const issued = (voucherId: string) =>
  buildIssueTransaction({
    voucherId,
    amount: 100,
    unit: 'EUR',
    decimals: 2,
    recipientPubkey: 'c'.repeat(64),
    at: 1_700_000_000_000,
  }) as unknown as Record<string, unknown>

/** A verified coupon of the stall's own `voucherId`, as dmCrypto hands it over. */
function presented(voucherId: string, ratio: number, sats: number) {
  const { token } = buildVoucherToken(
    { issuerId: STALL, voucherId, faceValue: 100, unit: 'EUR', faceDecimals: 2, issuanceRatio: ratio },
    [sats],
  )
  const value = Math.round(sats * ratio)
  return {
    token,
    metadata: {
      voucherId,
      issuerId: STALL,
      faceValue: value,
      faceUnit: 'EUR',
      faceDecimals: 2,
      validation: { signatureValid: true, legacyCanonical: false, signedFaceValue: 100, cappedAtFaceValue: false },
    },
  }
}

/** The receive row written for one presented coupon, found by its fresh token. */
const rowFor = (token: string) => {
  const fresh = store.vouchers.find((v) => v.token === `cashuBfresh-${token.slice(-16)}`)
  return store.rows.find((r) => r.tokenId === fresh?.token_id) as Record<string, unknown> | undefined
}

/** Two coupons redeemed at once; A's write lands while B's is in flight. */
async function redeemInterleaved(change: ReadonlySet<string> = new Set()) {
  const a = presented(VOUCHER_A, 0.07293946024799416, 206)
  const b = presented(VOUCHER_B, 0.07326007, 1365)
  gateFor(a.token)
  gateFor(b.token)
  ;(window as unknown as Record<string, unknown>).TokenRedemption = loadTokenRedemption(
    new Set([...change].map((k) => (k === 'a' ? a.token : b.token))),
  )
  const first = captured.redemptionAdapter!.redeem(a.token, { metadata: a.metadata })
  const second = captured.redemptionAdapter!.redeem(b.token, { metadata: b.metadata })
  gates.get(a.token)!.open()
  await first
  gates.get(b.token)!.open()
  await second
  return { a, b }
}

beforeEach(() => {
  stopDmPoll()
  gates.clear()
  store.rows = [issued(VOUCHER_A), issued(VOUCHER_B)]
  store.vouchers = []
  ;(globalThis as unknown as Record<string, unknown>)._buildReceiveTransactionRow = new Function(
    `${SOURCE}; return _buildReceiveTransactionRow;`,
  )()
  vi.stubGlobal('window', {
    walletStorageIntegration: {
      init: vi.fn(),
      atomicallyWrite: async (input: { vouchers?: Record<string, unknown>[]; transactions?: unknown[] }) => {
        store.vouchers.push(...(input.vouchers ?? []))
        store.rows.push(...((input.transactions ?? []) as Record<string, unknown>[]))
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  })
  installTokenIdFill()
  startDmPoll(STALL)
})

describe('two concurrent redeems through the real path (#145 review)', () => {
  /** Each coupon's row carries its own voucher and claim, through buildVoucher. */
  it('files each row under its own coupon', async () => {
    // Act
    const { a, b } = await redeemInterleaved()

    // Assert
    expect(rowFor(a.token)).toMatchObject({ voucherId: VOUCHER_A, amount: 15 })
    // 1365 x 0.07326007 = 99.9999..., which the cumulative credit floors to 99.
    expect(rowFor(b.token)).toMatchObject({ voucherId: VOUCHER_B, amount: 99 })
  })

  /** The same holds when a receive answers with change, through consolidateVoucher. */
  it('files each row under its own coupon when the receive returns change', async () => {
    // Act
    const { a, b } = await redeemInterleaved(new Set(['a', 'b']))

    // Assert
    expect(rowFor(a.token)).toMatchObject({ voucherId: VOUCHER_A, amount: 15 })
    // 1365 x 0.07326007 = 99.9999..., which the cumulative credit floors to 99.
    expect(rowFor(b.token)).toMatchObject({ voucherId: VOUCHER_B, amount: 99 })
  })

  /** The id names a redeem, not a coupon, so it never reaches storage. */
  it('stores no correlation id on the coupon row', async () => {
    // Act
    await redeemInterleaved()

    // Assert
    expect(store.vouchers.length).toBe(2)
    expect(store.vouchers.every((v) => !('correlation_id' in v))).toBe(true)
  })
})
