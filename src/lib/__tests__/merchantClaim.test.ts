import { readFileSync } from 'node:fs'

import type { TransactionRow } from '@imani/wallet-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #90: a redeemed voucher must move the merchant's claimed figure.
 *
 * Driven end to end through the pieces that actually write the row: dm-poll's
 * redemption adapter, the REAL legacy bridge (`withCorrelation` and
 * `installTokenIdFill`) and the REAL vendored row builder. Only the mint swap
 * is faked, and it is faked the way `tokenRedemption._persistRedeemed` behaves:
 * a voucher whose `voucher_id` came off the gateway's receive response, which
 * carries none (`ReceiveResponse` in imani-gateway-api has no id field), so
 * `buildVoucher` falls through to `crypto.randomUUID()`. That id is what every
 * redeemed row carried, which is why `issuedVoucher` summed an empty set and
 * the ceiling check in `refuseIfOverRedeemed` never saw a prior redemption.
 *
 * Every other suite passed with this broken because each one either mocked the
 * bridge or handed `issuedVoucher` rows with the right id already on them.
 */

const STALL = 'f'.repeat(64)
const VOUCHER_ID = '1d4410af-70f5-4c14-8606-519404684ea7'

const store = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  /** Null makes this wallet a customer, which `refuseIfAnotherStalls` skips. */
  merchant: null as Record<string, unknown> | null,
}))

vi.mock('../arrivalToast', () => ({
  announceArrival: () => {},
  announceBundleArrival: async () => {},
  resumeBundleArrivals: () => {},
  stopBundleArrivals: () => {},
}))
// sonner touches the DOM at import; the held-coupon toast is its own module for that reason (#133 review).
vi.mock('../heldToast', () => ({ announceHeld: () => {} }))
vi.mock('../refusalToast', () => ({ announceRefusal: () => {} }))
vi.mock('../queuedToast', () => ({ announceQueued: () => {}, settleQueued: () => {} }))
vi.mock('../merchant', () => ({
  loadMerchant: () => store.merchant,
  // Owner rule 2026-10-13: the relay's answer for an account with no local stall record.
  merchantStatus: async () => 'customer',
}))
vi.mock('../attestation', () => ({
  attestRedemption: async () => null,
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

const { startDmPoll, stopDmPoll, refuseIfOverRedeemed } = await import('../dmPoll')
const { _setReceivePacerForTests } = await import('../receivePacer')
// The ceiling tests below push up to 24 redemptions through the adapter in a
// loop; #110's pacing would make that minutes of real waiting. Pacing is
// pinned in receivePacer.test.ts.
_setReceivePacerForTests({ acquire: async () => {}, reset: () => {} })
const { installTokenIdFill } = await import('../legacyBridge')
const { toTransaction, buildIssueTransaction, buildCashbackTransaction } = await import('../transactions')
const { issuedVoucher } = await import('../issuedVoucher')
const { merchantClaimFor, boundedClaim } = await import('../merchantClaim')
const { toContent, toRow } = await import('../txRecords')
const { buildVoucherToken } = await import('./voucherFixtures')
const { parseVoucherToken, verifyVoucher, creditableFaceValue } = await import('../voucherToken')

const buildRow = new Function(
  readFileSync('shared/tokenRedemption.js', 'utf8') + '; return _buildReceiveTransactionRow;',
)() as (v: Record<string, unknown>, m?: Record<string, unknown>) => Record<string, unknown> | null

/** The stall's own issuance: 1000 XAF under the voucher's real id. */
const issued = () =>
  buildIssueTransaction({
    voucherId: VOUCHER_ID,
    amount: 1000,
    unit: 'XAF',
    decimals: 0,
    recipientPubkey: 'c'.repeat(64),
    at: 1_700_000_000_000,
  }) as unknown as Record<string, unknown>

/** What dmCrypto hands the adapter for a verified coupon worth `value`. */
const verified = (value: number) => ({
  voucherId: VOUCHER_ID,
  issuerId: STALL,
  faceValue: value,
  faceUnit: 'XAF',
  faceDecimals: 0,
  validation: { signatureValid: true, legacyCanonical: false, signedFaceValue: 1000, cappedAtFaceValue: false },
})

let swaps = 0
/** tokenRedemption's persist step, as it really behaves: no voucher id, no row. */
const redeem = vi.fn(async (_token: string, opts: { metadata?: Record<string, unknown> }) => {
  swaps += 1
  const voucher = {
    token_id: `tok-after-swap-${swaps}`,
    token: `cashuBfresh${swaps}`,
    voucher_id: crypto.randomUUID(),
    face_value: Number(opts.metadata?.faceValue ?? 0),
    // As `buildVoucher` sets it: the proofs' sats, which the row builder
    // falls back to when `face_value` is 0.
    token_amount: Number(opts.metadata?.tokenAmount ?? 0) || undefined,
    face_unit: 'XAF',
    face_decimals: 0,
    issuer_id: STALL,
    // As `buildVoucher` sets it (#145): the redeem this row came from.
    correlation_id: opts.metadata?.correlation_id,
  }
  await window.walletStorageIntegration!.atomicallyWrite({ vouchers: [voucher], transactions: [] })
  return voucher
})

const record = () =>
  issuedVoucher(store.rows.map((r) => toTransaction(r as unknown as TransactionRow)), VOUCHER_ID, {
    now: 1_700_000_000_000,
    stallPubkey: STALL,
  })!

beforeEach(() => {
  stopDmPoll()
  swaps = 0
  store.rows = [issued()]
  store.merchant = { pubkey: STALL, categories: [] }
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

describe("a voucher coming home to the stall that issued it (#90)", () => {
  it('moves claimed up and outstanding down by the amount redeemed', async () => {
    expect(record().claimedMinor).toBe(0)

    await captured.redemptionAdapter!.redeem('cashuA-full', { metadata: verified(1000) })

    expect(record().claimedMinor).toBe(1000)
    expect(record().outstandingMinor).toBe(0)
  })

  it('records a partial redemption as the partial amount, not the whole face', async () => {
    await captured.redemptionAdapter!.redeem('cashuA-part', { metadata: verified(400) })

    expect(record().claimedMinor).toBe(400)
    expect(record().outstandingMinor).toBe(600)
    expect(record().claims).toHaveLength(1)

    await captured.redemptionAdapter!.redeem('cashuA-rest', { metadata: verified(600) })
    expect(record().claimedMinor).toBe(1000)
    expect(record().outstandingMinor).toBe(0)
  })

  it('lets the ceiling see earlier redemptions, so the same face cannot be taken twice', async () => {
    await captured.redemptionAdapter!.redeem('cashuA-first', { metadata: verified(700) })

    await expect(refuseIfOverRedeemed(verified(700))).rejects.toThrow(/already paid out 700 of 1000/)
    await expect(refuseIfOverRedeemed(verified(300))).resolves.toBeUndefined()
  })

  // #94: a sender's declared bundle figures ride the same metadata. They are
  // display hints, so neither the booked amount nor the ceiling may read them.
  it('books and caps by the coupon, never by a declared bundle total', async () => {
    const declared = { bundleId: 'b'.repeat(32), bundleTotal: 999_999, bundlePartIndex: 0, bundlePartCount: 2 }
    await captured.redemptionAdapter!.redeem('cashuA-bundled', { metadata: { ...verified(400), ...declared } })

    expect(record().claimedMinor).toBe(400)
    expect(record().outstandingMinor).toBe(600)
    await expect(refuseIfOverRedeemed({ ...verified(700), ...declared })).rejects.toThrow(/already paid out 400 of 1000/)
    await expect(refuseIfOverRedeemed({ ...verified(600), ...declared })).resolves.toBeUndefined()
  })

  it('never files an UNVERIFIED coupon against a voucher, whatever the envelope says', async () => {
    // Envelope fields are sender-written. A coupon whose signature did not
    // verify naming our voucher id must not eat into (or pad) its figures.
    const unverified = { ...verified(400), validation: undefined }
    await captured.redemptionAdapter!.redeem('cashuA-plain', { metadata: unverified })

    expect(record().claimedMinor).toBe(0)
    expect(record().outstandingMinor).toBe(1000)
  })
})

describe('merchantClaimFor', () => {
  it('files nothing for a coupon this wallet did not issue', () => {
    // A customer passing someone else's voucher on. Stamping the id here would
    // switch the ceiling on for them and refuse an honest transfer back.
    expect(merchantClaimFor({ ...verified(400), issuerId: 'a'.repeat(64) }, STALL)).toBeUndefined()
  })

  it('files nothing without a verified signature', () => {
    expect(merchantClaimFor({ ...verified(400), validation: undefined }, STALL)).toBeUndefined()
    expect(
      merchantClaimFor(
        { ...verified(400), validation: { ...verified(400).validation, signatureValid: false } },
        STALL,
      ),
    ).toBeUndefined()
  })

  it('carries the signed id and the value of THIS token', () => {
    expect(merchantClaimFor(verified(400), STALL.toUpperCase())).toEqual({
      voucherId: VOUCHER_ID,
      amount: 400,
      unit: 'XAF',
      decimals: 0,
    })
  })
})

/** A stall issuance in any unit, for the unit and decimals cases. */
const issuedIn = (unit: string, decimals: number, voucherId = VOUCHER_ID) =>
  buildIssueTransaction({
    voucherId,
    amount: 1000,
    unit,
    decimals,
    recipientPubkey: 'c'.repeat(64),
    at: 1_700_000_000_000,
  }) as unknown as Record<string, unknown>

/** Rows the adapter wrote, excluding the stall's own issuance. */
const redemptions = () => store.rows.filter((r) => r.type !== 'issued')

describe('a self-signed voucher naming a victim voucher (review item 1)', () => {
  // The attack, built for real rather than described: a voucher that names
  // THIS stall as issuer and a voucher id of the attacker's choosing, signed
  // by a key the attacker made up. It verifies, because the key it is checked
  // against rides inside the voucher. That is why the signature gate alone is
  // not a claim gate.
  // `value` is what the token carries; `signedFace` is the ceiling the forger
  // chose. A big signed face is what lets the ceiling wave the token through.
  const forged = (voucherId: string, value: number, unit = 'XAF', signedFace = value) => {
    const { token } = buildVoucherToken(
      { issuerId: STALL, voucherId, faceValue: signedFace, unit, faceDecimals: 0, issuanceRatio: 1 },
      [value],
    )
    const parsed = parseVoucherToken(token)
    const { signatureValid } = verifyVoucher(parsed.voucher)
    return {
      voucherId: parsed.voucher.voucherId,
      issuerId: parsed.voucher.issuerId,
      faceValue: creditableFaceValue(parsed).faceValue,
      faceUnit: parsed.voucher.unit,
      faceDecimals: parsed.voucher.faceDecimals,
      validation: {
        signatureValid,
        legacyCanonical: false,
        signedFaceValue: parsed.voucher.faceValue,
        cappedAtFaceValue: false,
      },
    }
  }

  it('verifies, which is the premise of the attack', () => {
    expect(forged(VOUCHER_ID, 1000).validation.signatureValid).toBe(true)
  })

  it('files nothing against a voucher id this stall never issued', async () => {
    const made_up = '00000000-0000-4000-8000-000000000000'
    await captured.redemptionAdapter!.redeem('cashuA-forged-id', { metadata: forged(made_up, 500) })

    expect(redemptions().map((r) => r.voucherId)).not.toContain(made_up)
    expect(record().claimedMinor).toBe(0)
  })

  it('never claims more than the victim voucher has left', async () => {
    // The real customer has already spent 700 of 1000. The forger presents
    // 400 under a self-signed face of 5000, so the ceiling (which trusts the
    // SIGNED face) lets it through: 700 + 400 fits under 5000.
    await captured.redemptionAdapter!.redeem('cashuA-honest', { metadata: verified(700) })
    await captured.redemptionAdapter!.redeem('cashuA-forged-big', {
      metadata: forged(VOUCHER_ID, 400, 'XAF', 5000),
    })

    // Capped at the 300 the issuance had left: claimed never passes issued and
    // outstanding never goes negative.
    expect(record().claimedMinor).toBe(1000)
    expect(record().outstandingMinor).toBe(0)
    expect(redemptions().map((r) => r.amount)).toEqual([700, 300])
  })

  it('files nothing once the victim voucher is fully claimed', async () => {
    await captured.redemptionAdapter!.redeem('cashuA-all', { metadata: verified(1000) })
    await captured.redemptionAdapter!.redeem('cashuA-forged-late', {
      metadata: forged(VOUCHER_ID, 400, 'XAF', 5000),
    })

    expect(record().claimedMinor).toBe(1000)
    // The second row exists (the mint swap happened) but carries the builder's
    // id, so it is not summed against the voucher.
    expect(redemptions()).toHaveLength(2)
    expect(redemptions()[1].voucherId).not.toBe(VOUCHER_ID)
  })

  it('files nothing when the unit does not match the issuance', async () => {
    await captured.redemptionAdapter!.redeem('cashuA-forged-eur', {
      metadata: forged(VOUCHER_ID, 400, 'EUR'),
    })

    expect(redemptions()[0].voucherId).not.toBe(VOUCHER_ID)
    expect(record().claimedMinor).toBe(0)
  })
})

describe('boundedClaim', () => {
  const rows = () => store.rows.map((r) => toTransaction(r as unknown as TransactionRow))
  const claim = { voucherId: VOUCHER_ID, amount: 400, unit: 'XAF', decimals: 0 }

  it('passes a claim that fits, unchanged', () => {
    expect(boundedClaim(claim, rows())).toEqual(claim)
  })

  it('refuses a claim with no local issuance', () => {
    expect(boundedClaim({ ...claim, voucherId: 'nope' }, rows())).toBeUndefined()
    expect(boundedClaim(claim, [])).toBeUndefined()
  })

  it('caps at what the issuance has left', () => {
    expect(boundedClaim({ ...claim, amount: 1500 }, rows())?.amount).toBe(1000)
  })
})

describe('unit spelling and decimals (review item 2)', () => {
  it('counts a claim when the issuance stored a lower-case unit', async () => {
    store.rows = [issuedIn('xaf', 0)]
    await captured.redemptionAdapter!.redeem('cashuA-lower', { metadata: verified(400) })

    expect(record().claimedMinor).toBe(400)
  })

  it('counts a lower-case coupon unit against an upper-case issuance', async () => {
    await captured.redemptionAdapter!.redeem('cashuA-lower-coupon', {
      metadata: { ...verified(400), faceUnit: 'xaf' },
    })

    expect(record().claimedMinor).toBe(400)
  })

  it('counts a non-ISO unit even when the coupon signed different decimals', async () => {
    // Issuance files a merchant's own unit with `currencyDecimals`, which
    // falls back to 2. The coupon here signed 0. Taking the coupon's figure
    // would split the claim from its issuance under `isClaim`'s strict check.
    store.rows = [issuedIn('BEANS', 2)]
    await captured.redemptionAdapter!.redeem('cashuA-beans', {
      metadata: { ...verified(400), faceUnit: 'BEANS', faceDecimals: 0 },
    })

    expect(record().claimedMinor).toBe(400)
    expect(record().outstandingMinor).toBe(600)
  })

  it('derives candidate decimals by the issuance rule, not the signed one', () => {
    expect(merchantClaimFor({ ...verified(1), faceUnit: 'beans', faceDecimals: 0 }, STALL)).toEqual(
      { voucherId: VOUCHER_ID, amount: 1, unit: 'BEANS', decimals: 2 },
    )
  })
})

describe('the claim survives a restore (review item 6)', () => {
  it('is still counted after toContent/toRow', async () => {
    await captured.redemptionAdapter!.redeem('cashuA-restore', { metadata: verified(400) })
    const [stamped] = redemptions()

    const id = String(stamped.id)
    const restored = toRow(id, toContent(toTransaction(stamped as unknown as TransactionRow)))
    store.rows = [issued(), restored as unknown as Record<string, unknown>]

    expect(record().claimedMinor).toBe(400)
    expect(record().outstandingMinor).toBe(600)
  })
})

describe('a customer receiving a voucher it did not issue (review item 6)', () => {
  it('keeps the builder id, so no ceiling switches on for the customer', async () => {
    // A customer wallet: no stall record, so the cross-stall refusal is not
    // asked. The coupon is someone else's, whatever id it names.
    store.merchant = null
    const OTHER = 'a'.repeat(64)
    await captured.redemptionAdapter!.redeem('cashuA-customer', {
      metadata: { ...verified(400), issuerId: OTHER },
    })

    const [row] = redemptions()
    expect(row.voucherId).not.toBe(VOUCHER_ID)
    expect(row.amount).toBe(400)
    expect(record().claimedMinor).toBe(0)
  })

  it('stamps the exact value on a verified customer row, and keeps it through a restore (R1)', async () => {
    // A customer's received rows are the priors of the next part of the same
    // voucher. Without the unrounded value on them the ceiling treats them as
    // legacy history.
    store.merchant = null
    const RATIO = 0.05611672278338945
    const { token } = buildVoucherToken(
      { issuerId: 'a'.repeat(64), voucherId: VOUCHER_ID, faceValue: 1000, unit: 'XAF', faceDecimals: 0, issuanceRatio: RATIO },
      [9],
    )
    await captured.redemptionAdapter!.redeem(token, {
      metadata: { ...verified(1), issuerId: 'a'.repeat(64) },
    })

    const [row] = redemptions()
    expect(row.exactValue).toBeCloseTo(9 * RATIO, 12)
    const restored = toTransaction(toRow('d', toContent(toTransaction(row as unknown as TransactionRow))))
    expect(restored.exactValue).toBeCloseTo(9 * RATIO, 12)
  })

  it('books a verified zero credit as 0, never as the token sats (N-d)', async () => {
    // tokenRedemption's row builder reads `face_value || token_amount`, so a
    // part credited 0 fell through to its sats. Here: a customer's 7-sat part
    // at ratio 0.05, worth 0.35, credited 0.
    store.merchant = null
    const { token } = buildVoucherToken(
      { issuerId: 'a'.repeat(64), voucherId: VOUCHER_ID, faceValue: 1000, unit: 'XAF', faceDecimals: 0, issuanceRatio: 0.05 },
      [7],
    )
    await captured.redemptionAdapter!.redeem(token, {
      metadata: { ...verified(0), issuerId: 'a'.repeat(64), tokenAmount: 7 },
    })
    expect(redemptions()[0].amount).toBe(0)
  })

  it('books a zero credit on a coupon coming home with no issuance as 0 too (N-d)', async () => {
    // A stall's own coupon it has no `issued` row for, so no claim overwrites
    // the row. Its cumulative credit is 0.
    store.rows = []
    const { token } = buildVoucherToken(
      { issuerId: STALL, voucherId: VOUCHER_ID, faceValue: 1000, unit: 'XAF', faceDecimals: 0, issuanceRatio: 0.05 },
      [7],
    )
    await captured.redemptionAdapter!.redeem(token, { metadata: { ...verified(0), tokenAmount: 7 } })
    expect(redemptions()[0].amount).toBe(0)
  })

  it('stamps no exact value on an unverified coupon', async () => {
    store.merchant = null
    await captured.redemptionAdapter!.redeem('cashuA-unverified', {
      metadata: { ...verified(400), issuerId: 'a'.repeat(64), validation: undefined },
    })
    expect(redemptions()[0].exactValue).toBeUndefined()
  })
})

describe('two tabs redeeming one voucher past its ceiling (#97)', () => {
  /** A Locks API double that serialises per name, as the browser's does. */
  const withLocks = async (run: () => Promise<void>, serialise: boolean) => {
    const chains = new Map<string, Promise<unknown>>()
    const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: serialise
      ? { locks: { request: (name: string, fn: () => Promise<unknown>) => {
          const run = (chains.get(name) ?? Promise.resolve()).then(fn)
          chains.set(name, run.catch(() => {}))
          return run
        } } }
      : {} })
    try {
      await run()
    } finally {
      if (before) Object.defineProperty(globalThis, 'navigator', before)
      else delete (globalThis as { navigator?: unknown }).navigator
    }
  }

  const twoTabs = () =>
    Promise.allSettled([
      captured.redemptionAdapter!.redeem('cashuA-tab-1', { metadata: verified(700) }),
      captured.redemptionAdapter!.redeem('cashuA-tab-2', { metadata: verified(700) }),
    ])

  it('lets exactly one through when together they exceed the face', async () => {
    await withLocks(async () => {
      const outcomes = await twoTabs()
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1)
      expect(String((outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason))
        .toMatch(/already paid out 700 of 1000/)
    }, true)
    expect(swaps).toBe(1)
    expect(record().claimedMinor).toBe(700)
  })

  it('without the Locks API both check the same priors, which is the race the lock closes', async () => {
    // The control: proves the test above exercises a real interleaving
    // rather than passing because the calls happened to run one by one.
    await withLocks(async () => {
      const outcomes = await twoTabs()
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2)
    }, false)
    expect(swaps).toBe(2)
  })
})

describe('fractional-ratio parts through the till (review of 1a87c4f)', () => {
  /** A real token for one part, and the metadata dmCrypto would derive from it. */
  const presented = (proofs: number, ratio: number, face: number) => {
    const { token } = buildVoucherToken(
      { issuerId: STALL, voucherId: VOUCHER_ID, faceValue: face, unit: 'XAF', faceDecimals: 0, issuanceRatio: ratio },
      [proofs],
    )
    const parsed = parseVoucherToken(token)
    return {
      token,
      metadata: {
        ...verified(creditableFaceValue(parsed).faceValue),
        validation: { ...verified(0).validation, signedFaceValue: face },
      },
    }
  }

  const issuedFor = (amount: number) =>
    ({ ...issued(), amount }) as Record<string, unknown>

  it('books an honest 9 + 9 + 17802 split at exactly the face', async () => {
    const RATIO = 0.05611672278338945
    for (const proofs of [9, 9, 17802]) {
      const { token, metadata } = presented(proofs, RATIO, 1000)
      await captured.redemptionAdapter!.redeem(token, { metadata })
    }

    expect(redemptions().map((r) => r.amount)).toEqual([0, 1, 999])
    expect(record().claimedMinor).toBe(1000)
    expect(record().outstandingMinor).toBe(0)
  })

  it('checks, swaps and books two parts of one voucher one at a time across tabs (R9)', async () => {
    // Two tabs, each with its own poller, redeeming two half-unit parts of the
    // same voucher at once. Checked against the same priors, both would book 1
    // against a genuine 1. Under the per-voucher lock the second reads the
    // first's row and books 0.
    store.rows = [issuedFor(10)]
    const names: string[] = []
    let chain = Promise.resolve<unknown>(undefined)
    const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {
      locks: {
        request: (name: string, fn: () => Promise<unknown>) => {
          names.push(name)
          const run = chain.then(fn)
          chain = run.catch(() => {})
          return run
        },
      },
    } })
    try {
      const a = presented(1, 0.5, 10)
      const b = presented(1, 0.5, 10)
      await Promise.all([
        captured.redemptionAdapter!.redeem(a.token, { metadata: a.metadata }),
        captured.redemptionAdapter!.redeem(b.token, { metadata: b.metadata }),
      ])
      expect(names).toEqual([`imani-redeem:${VOUCHER_ID}`, `imani-redeem:${VOUCHER_ID}`])
      expect(redemptions().map((r) => r.amount)).toEqual([0, 1])
    } finally {
      if (before) Object.defineProperty(globalThis, 'navigator', before)
      else delete (globalThis as { navigator?: unknown }).navigator
    }
  })

  it('refuses tiny parts past the genuine value, before the swap', async () => {
    // Face 10 at ratio 0.5: 20 one-sat parts are the whole genuine value. Each
    // rounds to 1 on its own, so per-part rounding would honour 24 of them.
    // A fresh coupon per presentation: the mint swaps a token once, and the
    // ledger counts one received token once (#145), so reusing one token here
    // would test the dedupe rather than the cap.
    store.rows = [issuedFor(10)]
    let refused = 0
    for (let i = 0; i < 24; i++) {
      const { token, metadata } = presented(1, 0.5, 10)
      await captured.redemptionAdapter!.redeem(token, { metadata }).catch(() => {
        refused += 1
      })
    }

    expect(refused).toBe(4)
    expect(swaps).toBe(20)
    expect(redemptions().reduce((sum, r) => sum + Number(r.amount), 0)).toBe(10)
    expect(record().claimedMinor).toBe(10)
  })
})

describe('a cashback voucher coming home to the stall that issued it (#144)', () => {
  /** The stall's cashback, 1000 XAF, under the voucher id the portal returned. */
  const cashback = () =>
    buildCashbackTransaction({
      cashbackId: 'cb-1',
      claimCode: 'CB-ABCDE-FGHIJ',
      voucherId: VOUCHER_ID,
      amount: 1000,
      unit: 'XAF',
      decimals: 0,
      at: 1_700_000_000_000,
    }) as unknown as Record<string, unknown>

  beforeEach(() => {
    store.rows = [cashback()]
  })

  /** What was redeemed shows as claimed on the cashback voucher. */
  it('counts what was redeemed as claimed', async () => {
    // Act
    await captured.redemptionAdapter!.redeem('cashuA-cb-part', { metadata: verified(400) })

    // Assert
    expect(record().row.type).toBe('cashback')
    expect(record().claimedMinor).toBe(400)
    expect(record().outstandingMinor).toBe(600)
  })

  /** A second part that would take the cashback past its face is refused. */
  it('refuses a second part past the face', async () => {
    // Arrange
    await captured.redemptionAdapter!.redeem('cashuA-cb-first', { metadata: verified(700) })

    // Act, Assert
    await expect(refuseIfOverRedeemed(verified(700))).rejects.toThrow(/already paid out 700 of 1000/)
  })

  /** boundedClaim files against the cashback row and caps at its face. */
  it('bounds a claim by the cashback row', () => {
    // Arrange
    const rows = store.rows.map((r) => toTransaction(r as unknown as TransactionRow))

    // Act
    const bounded = boundedClaim({ voucherId: VOUCHER_ID, amount: 1500, unit: 'XAF', decimals: 0 }, rows)

    // Assert
    expect(bounded?.amount).toBe(1000)
  })
})
