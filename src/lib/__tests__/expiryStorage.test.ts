/**
 * #157: `expires_at` is stored in ONE format, epoch seconds, whichever door a
 * coupon came in by, and rows stored before this are repaired once.
 *
 * Driven through the real `openWallet` and the real WalletStorage on
 * fake-indexeddb. The save points are named by the writer each one uses:
 *
 * - `saveVoucher`: DM receive (dmPoll), the keep token after a send (pay.ts)
 * - `addRestoredVoucher`: NIP-60 restore from the relay (voucherRecords.ts)
 * - `atomicallyWrite`: imani-apps' tokenRedemption, which every claimed coupon
 *   goes through (cashback redeem, receive by link/paste, Sell's own copy)
 * - `clearAndReplaceAllVouchers`: import / restore-from-backup (shared/storage.js)
 */
import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletStorage, type VoucherRow } from '@imani/wallet-storage'

import { addRestoredVoucher, getWallet, openWallet, wipeWallet } from '../wallet'
import { migrateStoredExpiries, normaliseExpiry } from '../expiryStorage'
import { buildVoucherToken } from './voucherFixtures'
import { couponsFor, toVoucher } from '../merchants'
import { selectVouchers } from '@imani/wallet-core'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

vi.mock('../voucherRecords', () => ({
  publishVoucher: vi.fn().mockResolvedValue(undefined),
  tombstoneVoucher: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../txRecords', () => ({ publishTx: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../burn', () => ({ burnIfSelfIssued: vi.fn().mockResolvedValue(false) }))

const SECONDS = 1_798_588_800 // 2026-12-30T00:00:00Z

/** The shapes producers have actually written, and what each must store as. */
const FORMATS: Array<[string, unknown, unknown]> = [
  ['seconds number (DM payload)', SECONDS, SECONDS],
  ['milliseconds number', SECONDS * 1000, SECONDS],
  ['seconds numeric string (pre-v0.6.1 /inspect)', String(SECONDS), SECONDS],
  ['milliseconds numeric string', String(SECONDS * 1000), SECONDS],
  ['ISO string (/inspect, create-voucher)', '2026-12-30T00:00:00Z', SECONDS],
  ['ISO with millis', '2026-12-30T00:00:00.000Z', SECONDS],
  ['null (no expiry)', null, null],
  ['empty string', '', null],
  ['zero', 0, null],
]

let seq = 0
const token = () => `cashuB${'x'.repeat(16)}${(seq++).toString(16).padStart(8, '0')}`
const row = (expires_at: unknown, extra: Partial<VoucherRow> = {}) =>
  ({ token: token(), amount: 500, expires_at, ...extra }) as unknown as VoucherRow

const stored = async (t: string) =>
  (await getWallet().getAllVouchers()).find((r) => r.token === t)?.expires_at as unknown

let user: string

beforeEach(async () => {
  user = `u${seq++}`
  await openWallet(user)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await wipeWallet(user)
})

describe('every save point stores epoch seconds', () => {
  it.each(FORMATS)('saveVoucher: %s', async (_label, given, want) => {
    const r = row(given)
    await getWallet().saveVoucher(r)
    expect(await stored(r.token!)).toBe(want)
  })

  it.each(FORMATS)('NIP-60 restore: %s', async (_label, given, want) => {
    const r = row(given)
    await addRestoredVoucher(r)
    expect(await stored(r.token!)).toBe(want)
  })

  it.each(FORMATS)('atomicallyWrite (tokenRedemption, cashback redeem): %s', async (_l, given, want) => {
    const r = row(given)
    await getWallet().atomicallyWrite({ vouchers: [r] })
    expect(await stored(r.token!)).toBe(want)
  })

  it.each(FORMATS)('import / restore from backup: %s', async (_label, given, want) => {
    const r = { ...row(given), token_id: `id-${seq++}` } as VoucherRow
    await getWallet().clearAndReplaceAllVouchers([r])
    expect(await stored(r.token!)).toBe(want)
  })

  it('a partial write without expires_at does not erase the one held', async () => {
    const saved = await getWallet().saveVoucher(row(String(SECONDS)))
    await getWallet().saveVoucher({ token: saved.token, token_id: saved.token_id, status: 'spent' } as VoucherRow)
    expect(await stored(saved.token!)).toBe(SECONDS)
  })

  it('keeps a corrupt expiry exactly as given, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = row('next tuesday')
    await getWallet().saveVoucher(r)
    expect(await stored(r.token!)).toBe('next tuesday')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[expiry]'), expect.anything())
  })
})

describe('migrateStoredExpiries', () => {
  /** Write rows the way an older build did: no normaliser on the store. */
  async function seedLegacy(rows: VoucherRow[]): Promise<void> {
    const legacy = new WalletStorage({ userId: user })
    await legacy.init()
    await legacy.atomicallyWrite({ vouchers: rows })
    await legacy.close()
  }

  it.each(FORMATS)('repairs a stored %s', async (_label, given, want) => {
    const r = row(given)
    await seedLegacy([r])
    await migrateStoredExpiries(getWallet())
    expect(await stored(r.token!)).toBe(want)
  })

  it('is idempotent: a second run changes nothing', async () => {
    const rows = FORMATS.map(([, given]) => row(given))
    await seedLegacy(rows)

    const first = await migrateStoredExpiries(getWallet())
    const after = await getWallet().getAllVouchers()
    const second = await migrateStoredExpiries(getWallet())

    // Seconds and null were already canonical; the other seven were not.
    expect(first.rewritten).toBe(7)
    expect(second.rewritten).toBe(0)
    expect(await getWallet().getAllVouchers()).toEqual(after)
  })

  it('takes no readwrite pass when nothing needs repair', async () => {
    await getWallet().saveVoucher(row(SECONDS))
    const spy = vi.spyOn(getWallet(), 'rewriteVouchers')
    const result = await migrateStoredExpiries(getWallet())
    expect(result.rewritten).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('repairs an unreadable stored expiry from the expiry signed into the token', async () => {
    const { token } = buildVoucherToken({ expiresAt: SECONDS })
    const r = { token, amount: 500, expires_at: 'next tuesday' } as unknown as VoucherRow
    await seedLegacy([r])

    const result = await migrateStoredExpiries(getWallet())

    expect(await stored(token)).toBe(SECONDS)
    expect(result).toEqual({ rewritten: 1, unreadable: 0 })
  })

  it('keeps a corrupt value as it is, logs it, and never turns it into "no expiry"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const corrupt = row('next tuesday', { voucher_id: 'v-corrupt' })
    await seedLegacy([corrupt])

    const result = await migrateStoredExpiries(getWallet())

    expect(await stored(corrupt.token!)).toBe('next tuesday')
    expect(result.unreadable).toBe(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[expiry]'),
      expect.objectContaining({ voucher_id: 'v-corrupt', expires_at: 'next tuesday' }),
    )
  })

  // A coupon stored with a 9999-12-31 "practically never" expiry, in seconds or
  // milliseconds, must still be live after the repair has run on two opens. A
  // repair that re-read the stored seconds as milliseconds would date it to
  // 1978 and hide a live coupon as expired.
  it('never moves a far-future expiry into the past, however many times it runs', async () => {
    const NINES = 253_402_300_799 // 9999-12-31T23:59:59Z
    const asSeconds = row(NINES)
    const asMillis = row(NINES * 1000)
    await seedLegacy([asSeconds, asMillis])

    await migrateStoredExpiries(getWallet())
    await migrateStoredExpiries(getWallet())

    expect(await stored(asSeconds.token!)).toBe(NINES)
    expect(await stored(asMillis.token!)).toBe(NINES)
  })

  it('runs when the wallet opens, so a legacy row is canonical before anything reads it', async () => {
    await wipeWallet(user)
    user = `u${seq++}`
    const r = row(String(SECONDS))
    await seedLegacy([r])

    await openWallet(user)

    expect(await stored(r.token!)).toBe(SECONDS)
  })
})

describe('normaliseExpiry', () => {
  it('leaves every other field alone, and returns the same row when nothing changes', () => {
    const r = row(SECONDS, { status: 'active', face_value: 500 })
    expect(normaliseExpiry(r)).toBe(r)
    expect(normaliseExpiry(row(String(SECONDS), { face_value: 500 }))).toMatchObject({
      face_value: 500,
      expires_at: SECONDS,
    })
  })
})

// Review of PR #169 (LOW-3): the expiry the issuer SIGNED into the token is the
// authority, and the stored copy is only a cache of it. A stored value that is
// readable but wrong (say, a day in the past) used to win and hide a live coupon
// as expired. Now the signed tag wins whenever the token carries one.
describe('the signed expiry wins over a stored one (#169 review)', () => {
  const PAST = 1_600_000_000 // 2020-09-13, long gone
  const LATER = SECONDS + 86_400 // a day after SECONDS

  async function seedLegacy(rows: VoucherRow[]): Promise<void> {
    const legacy = new WalletStorage({ userId: user })
    await legacy.init()
    await legacy.atomicallyWrite({ vouchers: rows })
    await legacy.close()
  }

  // Writing a row whose stored expiry disagrees with its token stores the signed one.
  it('stores the signed expiry when a writer hands in a different readable one', () => {
    const { token } = buildVoucherToken({ expiresAt: SECONDS })
    const r = { token, amount: 500, expires_at: PAST } as unknown as VoucherRow
    expect(normaliseExpiry(r).expires_at).toBe(SECONDS)
  })

  // A row stored before this, with an earlier (past) expiry than its token says,
  // is repaired on open, stays live, and is ordered by the SIGNED date: it
  // comes after a coupon that genuinely expires sooner.
  it('keeps a coupon live and orders it by the signed date when the stored one is earlier', async () => {
    const merchantKey = schnorr.utils.randomSecretKey()
    const issuer = bytesToHex(schnorr.getPublicKey(merchantKey))
    const wronglyStored = buildVoucherToken({ expiresAt: LATER, voucherId: 'v-signed-later' }, [500], {}, merchantKey)
    const sooner = buildVoucherToken({ expiresAt: SECONDS, voucherId: 'v-sooner' }, [500], {}, merchantKey)
    const base = { amount: 500, face_value: 500, face_unit: 'GBP', face_decimals: 2, token_amount: 500, status: 'active', issuer_id: issuer }
    await seedLegacy([
      { ...base, token: wronglyStored.token, voucher_id: 'v-signed-later', expires_at: PAST },
      { ...base, token: sooner.token, voucher_id: 'v-sooner', expires_at: SECONDS },
    ] as unknown as VoucherRow[])

    await migrateStoredExpiries(getWallet())

    expect(await stored(wronglyStored.token)).toBe(LATER)
    const live = couponsFor(await getWallet().getAllVouchers(), issuer)
    expect(live.map((r) => r.voucher_id).sort()).toEqual(['v-signed-later', 'v-sooner'])
    const order = selectVouchers(live.map(toVoucher), 500).map((v) => v.voucher_id)
    expect(order).toEqual(['v-sooner', 'v-signed-later'])
  })

  // A token with no signed expiry leaves the stored value in charge, as before.
  it('falls back to the stored value when the token carries no signed expiry', () => {
    const r = row(String(SECONDS))
    expect(normaliseExpiry(r).expires_at).toBe(SECONDS)
  })
})
