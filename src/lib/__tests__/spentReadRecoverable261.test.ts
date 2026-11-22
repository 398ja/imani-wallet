import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * #261: a `claimed` written on one SPENT checkstate is recoverable. The reason and the time are
 * recorded, the next due pass reads the mint again, and an UNSPENT answer opens the link again
 * (here, past its expiry, so the take-back it stopped runs).
 */
const ID = hexToBytes('44'.repeat(32))
const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  redeemed: [] as string[],
  wraps: new Map<string, string[]>(),
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
    addTransaction: async (row: Record<string, unknown>) => void h.rows.push(row),
  }),
  notifyWalletChanged: () => {},
}))
vi.mock('../txRecords', () => ({ publishTx: async () => {} }))
vi.mock('../nap', () => ({ getSigner: () => ({ withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(ID) }) }))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({}),
  withCorrelation: async (_ids: unknown, run: (id: string) => unknown) => run('corr'),
}))
vi.mock('../trustedMint', () => ({ loadTrustedMints: async () => {}, checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))
vi.mock('../pay', () => ({ sendVouchers: async () => ({}) }))
vi.mock('../giftLink', async (orig) => {
  const real = await orig<typeof import('../giftLink')>()
  return {
    ...real,
    fetchGiftWraps: async (secret: Uint8Array) => ((h.wraps.get(real.linkPubOf(secret)) ?? []).length ? [{ id: 'w' }] : []),
    giftTokensFrom: async (secret: Uint8Array) => (h.wraps.get(real.linkPubOf(secret)) ?? []).map((token) => ({ token, sentAt: 1_800_000_000 })),
  }
})

import { deriveLinkSecret, linkPubOf, secretToText } from '../giftLink'
import { reconcileGiftLinks, resetLinkSettlesForTests } from '../giftLinks'
import { CLAIM_RECHECK_AFTER_MS, asGiftLinkRecord } from '../transactions'
import { buildVoucherToken } from './voucherFixtures'

const token = buildVoucherToken({}, [8]).token
const T0 = 1_800_000_100_000
const link = () => h.rows[0].link as Record<string, unknown>

beforeEach(() => {
  resetLinkSettlesForTests()
  h.rows = [{ id: 'sent:t0', type: 'sent', timestamp: 0, link: { k: secretToText(deriveLinkSecret(ID, 0)), i: 0, x: 1_800_000_050, status: 'outstanding' } }]
  h.redeemed = []
  h.wraps.clear()
  h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', {
    location: { origin: 'https://wallet.example' },
    TokenRedemption: { redeem: async (t: string) => void h.redeemed.push(t) },
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a claim on one SPENT read is recoverable (#261)', () => {
  it('records the reason and the time, unconfirmed', async () => {
    await reconcileGiftLinks(T0, async () => 'SPENT')
    expect(link()).toMatchObject({ status: 'claimed', claimReason: 'mint-spent', spentSeenAt: T0 })
    expect(link().verifiedAt).toBeUndefined()
    // And the record survives the relay round trip that restores it.
    expect(asGiftLinkRecord(link())).toMatchObject({ claimReason: 'mint-spent', spentSeenAt: T0 })
  })

  it('a later UNSPENT answer undoes it: the link opens again and the take-back runs', async () => {
    await reconcileGiftLinks(T0, async () => 'SPENT')
    await reconcileGiftLinks(T0 + CLAIM_RECHECK_AFTER_MS, async () => 'UNSPENT')
    expect(link().status).toBe('reclaimed')
    expect(link().claimReason).toBeUndefined()
    expect(h.redeemed).toEqual([token])
  })

  it('not re-read before it is due', async () => {
    await reconcileGiftLinks(T0, async () => 'SPENT')
    const state = vi.fn(async () => 'UNSPENT' as const)
    await reconcileGiftLinks(T0 + CLAIM_RECHECK_AFTER_MS - 1, state)
    expect(state).not.toHaveBeenCalled()
    expect(link().status).toBe('claimed')
  })

  it('SPENT again confirms it, and it is never read again', async () => {
    await reconcileGiftLinks(T0, async () => 'SPENT')
    await reconcileGiftLinks(T0 + CLAIM_RECHECK_AFTER_MS, async () => 'SPENT')
    expect(link()).toMatchObject({ status: 'claimed', verifiedAt: T0 + CLAIM_RECHECK_AFTER_MS })
    const state = vi.fn(async () => 'UNSPENT' as const)
    await reconcileGiftLinks(T0 + 10 * CLAIM_RECHECK_AFTER_MS, state)
    expect(state).not.toHaveBeenCalled()
  })

  it('no answer from the mint leaves it as it is, for the next pass', async () => {
    await reconcileGiftLinks(T0, async () => 'SPENT')
    await reconcileGiftLinks(T0 + CLAIM_RECHECK_AFTER_MS, async () => 'UNKNOWN')
    expect(link()).toMatchObject({ status: 'claimed', claimReason: 'mint-spent' })
    expect(link().verifiedAt).toBeUndefined()
  })
})
