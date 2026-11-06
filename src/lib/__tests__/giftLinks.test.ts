import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * Claim links phase 4, the sender's side (spec 3.3 "Status and reclaim", Q4, Q5): the limit, the
 * counter, the NUT-07 status, reclaim after `x`, Take it back, and the restore scan's gap rule.
 * Storage, the signer and the redeem are faked at their module boundaries.
 */

const ID = hexToBytes('33'.repeat(32))

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  redeemed: [] as Array<{ token: string; source: string }>,
  redeemFails: null as null | string,
  wraps: new Map<string, string[]>(),
  sent: [] as Array<Record<string, unknown>>,
  signerKey: null as Uint8Array | null,
  /** The send delivers a wrap to this link key (as the gateway does on COMPLETED). */
  deliverTo: null as string | null,
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
  getSigner: () => {
    if (!h.signerKey) throw new Error('remote signer')
    return { withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(h.signerKey!) }
  },
}))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({}),
  withCorrelation: async (_ids: unknown, run: (id: string) => unknown) => run('corr'),
}))
vi.mock('../trustedMint', () => ({
  loadTrustedMints: async () => {},
  checkTokenBacking: () => ({ outcome: 'accept' }),
}))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))
vi.mock('../pay', () => ({
  sendVouchers: async (args: Record<string, unknown>) => {
    h.sent.push(args)
    const to = (args.recipient as { pubkey: string }).pubkey
    if (h.deliverTo === to) h.wraps.set(to, ['cashuBdelivered'])
    return { id: 's1', requested: 100, delivered: 100, parts: 1 }
  },
}))
// The wrap fetch is the network: each link key answers with the tokens registered for its pubkey.
vi.mock('../giftLink', async (orig) => {
  const real = await orig<typeof import('../giftLink')>()
  return {
    ...real,
    // A key with nothing registered has no wraps (so the send's free-key probe passes it).
    fetchGiftWraps: async (secret: Uint8Array) =>
      (h.wraps.get(real.linkPubOf(secret)) ?? []).length ? [{ id: real.linkPubOf(secret) }] : [],
    giftTokensFrom: async (secret: Uint8Array) =>
      (h.wraps.get(real.linkPubOf(secret)) ?? []).map((token) => ({ token, sentAt: 1_800_000_000 })),
  }
})

import { deriveLinkSecret, linkPubOf, secretToText, type ProofState } from '../giftLink'
import {
  MAX_EXPIRED_UNRETURNED,
  MAX_OUTSTANDING_LINKS,
  RESTORE_GAP,
  allocateLink,
  linkCounts,
  linkLimitMessage,
  linkRows,
  markLinksNoticed,
  settleAndCountLinks,
  outstandingLinkCount,
  tooManyExpiredMessage,
  nextLinkIndex,
  reconcileGiftLinks,
  resetLinkSettlesForTests,
  RESTORE_PROBE_BATCH,
  RESTORE_SCAN_EVERY_MS,
  restoreScan,
  restoreScanIfDue,
  sendGift,
  takeBack,
  tooManyLinksMessage,
} from '../giftLinks'
import { buildVoucherToken } from './voucherFixtures'

const store = new Map<string, string>()
const PUB = 'a'.repeat(64)

function linkRow(i: number, status = 'outstanding', x = 1_900_000_000) {
  const k = secretToText(deriveLinkSecret(ID, i))
  return { id: `sent:t${i}`, type: 'sent', timestamp: i, link: { k, i, x, status } }
}

beforeEach(() => {
  resetLinkSettlesForTests()
  store.clear()
  h.rows = []
  h.redeemed = []
  h.redeemFails = null
  h.wraps.clear()
  h.sent = []
  h.signerKey = ID
  h.deliverTo = null
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('window', {
    location: { origin: 'https://wallet.example' },
    TokenRedemption: {
      redeem: async (token: string, opts: { source: string }) => {
        if (h.redeemFails) throw new Error(h.redeemFails)
        h.redeemed.push({ token, source: opts.source })
        return {}
      },
    },
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('allocating link keys (spec 3.3)', () => {
  it('derives at the next index, skipping any a row already uses', () => {
    const a = allocateLink(PUB, new Set([0, 1]))
    expect(a.i).toBe(2)
    expect(a.linkPub).toBe(linkPubOf(deriveLinkSecret(ID, 2)))
  })

  it('uses a random secret when the key is in a remote signer', () => {
    h.signerKey = null
    const a = allocateLink(PUB, new Set())
    expect(a.i).toBeUndefined()
    expect(a.secret).toHaveLength(32)
  })
})

describe('Send by link (Q5)', () => {
  it(`refuses an eleventh outstanding link with the spec's copy, before anything moves`, async () => {
    h.rows = Array.from({ length: MAX_OUTSTANDING_LINKS }, (_, i) => linkRow(i))
    await expect(sendGift({ payer: PUB, merchant: {} as never, unit: 'EUR', amount: 100, x: 1_900_000_000 })).rejects.toThrow(
      tooManyLinksMessage(),
    )
    expect(h.sent).toHaveLength(0)
    expect(tooManyLinksMessage()).toBe('You have 10 links waiting to be claimed. Take one back or wait for it to be claimed.')
  })

  it('counts claimed and taken-back links as no longer waiting', async () => {
    h.rows = [...Array.from({ length: 9 }, (_, i) => linkRow(i)), linkRow(9, 'claimed'), linkRow(10, 'reclaimed')]
    // The delivery check (spec 3.3 send step 3) finds the wrap at once.
    h.deliverTo = linkPubOf(deriveLinkSecret(ID, 11))
    const out = await sendGift({ payer: PUB, merchant: {} as never, unit: 'EUR', amount: 100, x: 1_900_000_000 })
    expect(out.delivered).toBe(true)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].link).toMatchObject({ i: 11, status: 'outstanding', x: 1_900_000_000 })
    expect((h.sent[0].recipient as { pubkey: string }).pubkey).toBe(linkPubOf(deriveLinkSecret(ID, 11)))
    expect(out.link).toBe(`https://wallet.example/g#v=1&k=${secretToText(deriveLinkSecret(ID, 11))}&x=1900000000`)
    // The index is reserved before the send, so an unknown outcome can never reuse it.
    expect(nextLinkIndex(PUB)).toBe(12)
  })
})

describe('status and reclaim (spec 3.3)', () => {
  const token = buildVoucherToken({}, [8]).token

  it('marks a link claimed when its proofs are spent, and redeems nothing', async () => {
    h.rows = [linkRow(0)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    const out = await reconcileGiftLinks(Date.now(), async () => 'SPENT')
    expect(out).toEqual({ claimed: 1, reclaimed: 0 })
    expect((h.rows[0].link as { status: string }).status).toBe('claimed')
    expect(h.redeemed).toHaveLength(0)
  })

  it('leaves an unspent link alone before x', async () => {
    h.rows = [linkRow(0, 'outstanding', 2_000_000_000)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    await reconcileGiftLinks(1_900_000_000_000, async () => 'UNSPENT')
    expect(h.redeemed).toHaveLength(0)
    expect((h.rows[0].link as { status: string }).status).toBe('outstanding')
  })

  it('takes an unspent link back after x, with source gift_link_reclaim', async () => {
    h.rows = [linkRow(0, 'outstanding', 1_800_000_000)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    const out = await reconcileGiftLinks(1_800_000_001_000, async () => 'UNSPENT')
    expect(out).toEqual({ claimed: 0, reclaimed: 1 })
    expect(h.redeemed).toEqual([{ token, source: 'gift_link_reclaim' }])
    expect((h.rows[0].link as { status: string }).status).toBe('reclaimed')
  })

  it('reads a race lost at the mint as claimed, not as an error', async () => {
    h.rows = [linkRow(0, 'outstanding', 1_800_000_000)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    h.redeemFails = 'Token already spent (11001)'
    await reconcileGiftLinks(1_800_000_001_000, async () => 'UNSPENT')
    expect((h.rows[0].link as { status: string }).status).toBe('claimed')
  })

  it('never reclaims when the mint cannot answer', async () => {
    h.rows = [linkRow(0, 'outstanding', 1_800_000_000)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    await reconcileGiftLinks(1_800_000_001_000, async (): Promise<ProofState> => 'UNKNOWN')
    expect(h.redeemed).toHaveLength(0)
  })
})

describe('Take it back (Q4)', () => {
  it('receives the link itself before x', async () => {
    const token = buildVoucherToken({}, [8]).token
    h.rows = [linkRow(0, 'outstanding', 2_000_000_000)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    vi.stubGlobal('fetch', async () => Response.json({ states: [{ state: 'UNSPENT' }] }))
    const out = await takeBack(String((h.rows[0].link as { k: string }).k))
    expect(out.kind).toBe('ok')
    expect(h.redeemed).toEqual([{ token, source: 'gift_link_reclaim' }])
    expect((h.rows[0].link as { status: string }).status).toBe('reclaimed')
  })
})

describe('the restore scan (spec 3.3: i = 0 … last + 20)', () => {
  const token = buildVoucherToken({}, [8]).token
  const probeSeen: number[] = []
  const probeFor = (holding: Set<number>) => async (secret: Uint8Array) => {
    for (let i = 0; i < 200; i++) {
      if (linkPubOf(deriveLinkSecret(ID, i)) === linkPubOf(secret)) {
        probeSeen.push(i)
        return holding.has(i) ? [{ token: `${token}`, sentAt: 1_800_000_000 }] : []
      }
    }
    return []
  }
  beforeEach(() => {
    probeSeen.length = 0
  })

  it(`scans ${RESTORE_GAP + 1} indices on an empty wallet and adopts what it finds`, async () => {
    const adopted = await restoreScan(PUB, probeFor(new Set([3])), async () => 'UNSPENT', 1_800_000_000_000)
    expect(adopted).toBe(1)
    // Found at 3, so the window slides to 3 + 20.
    expect(Math.max(...probeSeen)).toBe(3 + RESTORE_GAP)
    expect(h.rows).toHaveLength(1)
    expect(h.rows[0]).toMatchObject({ type: 'sent', link: { i: 3, status: 'outstanding' } })
    expect(nextLinkIndex(PUB)).toBe(4)
  })

  it('slides past a run with gaps shorter than 20, and stops 20 after the last', async () => {
    await restoreScan(PUB, probeFor(new Set([0, 15, 34])), async () => 'UNSPENT', 1_800_000_000_000)
    expect(Math.max(...probeSeen)).toBe(34 + RESTORE_GAP)
  })

  it('does not adopt a claimed link, nor one a row already knows', async () => {
    h.rows = [linkRow(2)]
    const adopted = await restoreScan(PUB, probeFor(new Set([2, 5])), async () => 'SPENT', 1_800_000_000_000)
    expect(adopted).toBe(0)
    expect(h.rows).toHaveLength(1)
  })

  it('does nothing for a remote-signer account (its random links are in the encrypted history)', async () => {
    h.signerKey = null
    expect(await restoreScan(PUB, probeFor(new Set([0])))).toBe(0)
    expect(probeSeen).toHaveLength(0)
  })
})

describe('#295 phase 0: the limit counts only links that can still be claimed', () => {
  const token = buildVoucherToken({ expiresAt: 1_900_000_000 }, [8]).token
  const NOW = 1_850_000_000_000
  const PAST = 1_840_000_000
  const FUTURE = 1_900_000_000

  it('counts outstanding links before x as waiting, and expired ones separately', async () => {
    h.rows = [
      ...Array.from({ length: 4 }, (_, i) => linkRow(i, 'outstanding', FUTURE)),
      ...Array.from({ length: 3 }, (_, i) => linkRow(10 + i, 'outstanding', PAST)),
      linkRow(20, 'claimed', FUTURE),
      linkRow(21, 'reclaimed', PAST),
    ]
    expect(await linkCounts(NOW)).toEqual({ waiting: 4, expiredUnreturned: 3 })
    expect(await outstandingLinkCount(NOW)).toBe(4)
  })

  it('takes expired links back BEFORE counting, so ten expired links leave room for an eleventh', async () => {
    h.rows = Array.from({ length: 10 }, (_, i) => linkRow(i, 'outstanding', PAST))
    for (let i = 0; i < 10; i++) h.wraps.set(linkPubOf(deriveLinkSecret(ID, i)), [token])
    h.deliverTo = linkPubOf(deriveLinkSecret(ID, 10))
    const out = await sendGift({
      payer: PUB, merchant: {} as never, unit: 'EUR', amount: 100, x: FUTURE,
      nowMs: NOW, state: async () => 'UNSPENT',
    })
    expect(out.delivered).toBe(true)
    // All ten came back through the ordinary reclaim first, then the send went out.
    expect(h.redeemed.filter((r) => r.source === 'gift_link_reclaim')).toHaveLength(10)
    expect(h.rows.slice(0, 10).every((r) => (r.link as { status: string }).status === 'reclaimed')).toBe(true)
    expect(h.sent).toHaveLength(1)
  })

  it('does not count an expired link that could not be taken back against the ten waiting', async () => {
    h.rows = [
      ...Array.from({ length: 9 }, (_, i) => linkRow(i, 'outstanding', FUTURE)),
      linkRow(9, 'outstanding', PAST),
    ]
    h.deliverTo = linkPubOf(deriveLinkSecret(ID, 10))
    // The mint cannot answer, so nothing is taken back, yet the expired link no longer counts.
    await sendGift({ payer: PUB, merchant: {} as never, unit: 'EUR', amount: 100, x: FUTURE, nowMs: NOW, state: async () => 'UNKNOWN' })
    expect(h.sent).toHaveLength(1)
  })

  it('caps expired links that have not come back at ten, so they cannot pile up', async () => {
    h.rows = Array.from({ length: MAX_EXPIRED_UNRETURNED }, (_, i) => linkRow(i, 'outstanding', PAST))
    await expect(
      sendGift({ payer: PUB, merchant: {} as never, unit: 'EUR', amount: 100, x: FUTURE, nowMs: NOW, state: async () => 'UNKNOWN' }),
    ).rejects.toThrow(tooManyExpiredMessage())
    expect(h.sent).toHaveLength(0)
    expect(MAX_EXPIRED_UNRETURNED).toBe(10)
    expect(tooManyExpiredMessage()).not.toMatch(/mint|proof|token|relay|nostr|key/i)
  })

  it('opening Send settles first: ten expired links leave the screen free for an eleventh', async () => {
    h.rows = Array.from({ length: 10 }, (_, i) => linkRow(i, 'outstanding', PAST))
    for (let i = 0; i < 10; i++) h.wraps.set(linkPubOf(deriveLinkSecret(ID, i)), [token])
    const counts = await settleAndCountLinks(NOW, async () => 'UNSPENT')
    expect(counts).toEqual({ waiting: 0, expiredUnreturned: 0 })
    expect(linkLimitMessage(counts)).toBeNull()
  })

  it('still refuses an eleventh link that can be claimed', async () => {
    h.rows = Array.from({ length: MAX_OUTSTANDING_LINKS }, (_, i) => linkRow(i, 'outstanding', FUTURE))
    await expect(
      sendGift({ payer: PUB, merchant: {} as never, unit: 'EUR', amount: 100, x: FUTURE, nowMs: NOW, state: async () => 'UNSPENT' }),
    ).rejects.toThrow(tooManyLinksMessage())
    expect(h.sent).toHaveLength(0)
  })
})

describe('review of #367', () => {
  const NOW = 1_850_000_000_000
  const PAST = 1_840_000_000

  it('closes a link whose coupon has itself expired, so it cannot hold the expired limit for ever', async () => {
    // The coupon lapsed before now: the mint refuses it to everyone, the sender included.
    const lapsed = buildVoucherToken({ expiresAt: PAST + 3600 }, [8]).token
    h.rows = Array.from({ length: MAX_EXPIRED_UNRETURNED }, (_, i) => linkRow(i, 'outstanding', PAST))
    for (let i = 0; i < MAX_EXPIRED_UNRETURNED; i++) h.wraps.set(linkPubOf(deriveLinkSecret(ID, i)), [lapsed])
    h.redeemFails = 'voucher_expired: Voucher has expired and cannot be redeemed'
    const counts = await settleAndCountLinks(NOW, async () => 'UNSPENT')
    expect(counts).toEqual({ waiting: 0, expiredUnreturned: 0 })
    expect(h.rows.every((r) => (r.link as { status: string }).status === 'expired')).toBe(true)
    // Nothing was even tried at the mint.
    expect(h.redeemed).toHaveLength(0)
  })

  it('still takes back a link whose coupon expired only within the grace (a fast wallet clock)', async () => {
    const recent = buildVoucherToken({ expiresAt: NOW / 1000 - 60 }, [8]).token
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [recent])
    await reconcileGiftLinks(NOW, async () => 'UNSPENT')
    expect(h.redeemed).toHaveLength(1)
    expect((h.rows[0].link as { status: string }).status).toBe('reclaimed')
  })

  it('never relabels a link another settle already closed (Taken back stays Taken back)', async () => {
    const token = buildVoucherToken({ expiresAt: 1_900_000_000 }, [8]).token
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    // A second settle (start-up and Send at once) wins the take-back while this one is at the mint;
    // this one then reads "already spent", which alone would say Claimed.
    vi.stubGlobal('window', {
      location: { origin: 'https://wallet.example' },
      TokenRedemption: {
        redeem: async () => {
          Object.assign(h.rows[0], { link: { ...(h.rows[0].link as object), status: 'reclaimed', closedAt: NOW } })
          throw new Error('Token already spent (11001)')
        },
      },
    })
    await reconcileGiftLinks(NOW, async () => 'UNSPENT')
    expect((h.rows[0].link as { status: string }).status).toBe('reclaimed')
  })

  it('marking a notice keeps a take-back that landed meanwhile', async () => {
    h.rows = [linkRow(0, 'outstanding', PAST)]
    const snapshot = (await linkRows()).map((r) => ({ ...r, link: { ...r.link } }))
    Object.assign(h.rows[0], { link: { ...(h.rows[0].link as object), status: 'reclaimed', closedAt: NOW } })
    await markLinksNoticed(snapshot, NOW)
    expect(h.rows[0].link).toMatchObject({ status: 'reclaimed', noticedAt: NOW })
  })

  it('opening Send waits at most the budget for a settle that hangs', async () => {
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [buildVoucherToken({ expiresAt: 1_900_000_000 }, [8]).token])
    const started = Date.now()
    const counts = await settleAndCountLinks(NOW, () => new Promise<ProofState>(() => {}), 50)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(counts).toEqual({ waiting: 0, expiredUnreturned: 1 })
  })

  it('a take-back by hand marks the link noticed, so no expiry notice follows', async () => {
    const token = buildVoucherToken({}, [8]).token
    h.rows = [linkRow(0, 'outstanding', 2_000_000_000)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    vi.stubGlobal('fetch', async () => Response.json({ states: [{ state: 'UNSPENT' }] }))
    await takeBack(String((h.rows[0].link as { k: string }).k))
    expect((h.rows[0].link as { noticedAt?: number }).noticedAt).toEqual(expect.any(Number))
  })
})

describe('second check of #367', () => {
  const NOW = 1_850_000_000_000
  const PAST = 1_840_000_000

  it('a wallet clock more than the grace fast never closes a link the mint would still give back', async () => {
    // The coupon expires in an hour by the mint's clock, but this device runs 3 h fast.
    const live = buildVoucherToken({ expiresAt: NOW / 1000 + 3600 }, [8]).token
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [live])
    await reconcileGiftLinks(NOW + 3 * 3600_000, async () => 'UNSPENT')
    expect(h.redeemed).toHaveLength(1)
    expect((h.rows[0].link as { status: string }).status).toBe('reclaimed')
  })

  it('closes a link of lapsed coupons only after the mint refused the take-back', async () => {
    const lapsed = buildVoucherToken({ expiresAt: PAST + 3600 }, [8]).token
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [lapsed])
    h.redeemFails = 'voucher_expired: Voucher has expired and cannot be redeemed'
    await reconcileGiftLinks(NOW, async () => 'UNSPENT')
    expect((h.rows[0].link as { status: string }).status).toBe('expired')
  })

  it('a link whose live coupon came back and whose other coupon lapsed is closed, not held until the live one expires', async () => {
    const lapsed = buildVoucherToken({ expiresAt: PAST + 3600 }, [8]).token
    const live = buildVoucherToken({ expiresAt: 1_900_000_000 }, [8]).token
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [live, lapsed])
    h.redeemFails = 'voucher_expired: Voucher has expired and cannot be redeemed'
    // The live coupon already came back on an earlier run; only the lapsed one is unspent.
    await reconcileGiftLinks(NOW, async (t) => (t === live ? 'SPENT' : 'UNSPENT'))
    expect((h.rows[0].link as { status: string }).status).toBe('expired')
    expect(await linkCounts(NOW)).toEqual({ waiting: 0, expiredUnreturned: 0 })
  })

  it('a notice filed while a take-back lands loses neither (no read-then-write window)', async () => {
    const token = buildVoucherToken({ expiresAt: 1_900_000_000 }, [8]).token
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    const snapshot = await linkRows()
    let notice: Promise<void> | undefined
    vi.stubGlobal('window', {
      location: { origin: 'https://wallet.example' },
      TokenRedemption: {
        redeem: async () => {
          // The notice pass starts while the take-back is at the mint, and reads the link then.
          notice = markLinksNoticed(snapshot, NOW)
          return {}
        },
      },
    })
    await reconcileGiftLinks(NOW, async () => 'UNSPENT')
    await notice
    expect(h.rows[0].link).toMatchObject({ status: 'reclaimed', noticedAt: NOW })
  })
  it('closes on the gateway\'s own expiry refusal, which comes before the swap reaches the mint (third check)', async () => {
    // gateway-customer JdbcWalletPort.inspectVoucherReceiveMetadata, verbatim, as api.js surfaces it.
    // Lapsed 3 h ago: inside the week, so only recognising the refusal closes it.
    const lapsed = buildVoucherToken({ expiresAt: NOW / 1000 - 3 * 3600 }, [8]).token
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [lapsed])
    h.redeemFails = 'Voucher token expired. Reason: voucher expiry exceeded. Suggestion: request a new voucher.'
    await reconcileGiftLinks(NOW, async () => 'UNSPENT')
    expect((h.rows[0].link as { status: string }).status).toBe('expired')
  })

  it('a number that merely contains 90016 is not the mint\'s expiry code (third check)', async () => {
    const lapsed = buildVoucherToken({ expiresAt: NOW / 1000 - 3 * 3600 }, [8]).token
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [lapsed])
    h.redeemFails = 'HTTP 503 upstream request 1900163 failed'
    await reconcileGiftLinks(NOW, async () => 'UNSPENT')
    expect((h.rows[0].link as { status: string }).status).toBe('outstanding')
  })

  it('a link write that throws does not hold up the next one (third check)', async () => {
    h.rows = [linkRow(0, 'outstanding', PAST)]
    const snapshot = await linkRows()
    // The store fails the first write once (IndexedDB quota, say); the chain must not stay rejected.
    let failures = 1
    const store = (await import('../wallet')).getWallet()
    const real = store.updateTransaction
    vi.spyOn(await import('../wallet'), 'getWallet').mockReturnValue({
      ...store,
      updateTransaction: async (id: string, patch: Record<string, unknown>) => {
        if (failures-- > 0) throw new Error('QuotaExceededError')
        return real(id, patch as never)
      },
    } as never)
    await expect(markLinksNoticed(snapshot, NOW)).rejects.toThrow('QuotaExceededError')
    await markLinksNoticed(snapshot, NOW + 1)
    expect(h.rows[0].link).toMatchObject({ status: 'outstanding', noticedAt: NOW + 1 })
  })

  it('a failed take-back that is not the mint saying "expired" keeps the link open for a week', async () => {
    const lapsed = buildVoucherToken({ expiresAt: NOW / 1000 - 3 * 3600 }, [8]).token
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [lapsed])
    h.redeemFails = 'Failed to fetch'
    await reconcileGiftLinks(NOW, async () => 'UNSPENT')
    expect((h.rows[0].link as { status: string }).status).toBe('outstanding')
    // A week past the coupon's own expiry it is closed whatever the failure was.
    await reconcileGiftLinks(NOW + 8 * 86_400_000, async () => 'UNSPENT')
    expect((h.rows[0].link as { status: string }).status).toBe('expired')
  })

  it('two settles at once (start-up and Send): the take-back that won is not relabelled Claimed', async () => {
    const token = buildVoucherToken({ expiresAt: 1_900_000_000 }, [8]).token
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    let calls = 0
    vi.stubGlobal('window', {
      location: { origin: 'https://wallet.example' },
      TokenRedemption: {
        redeem: async () => {
          calls += 1
          if (calls === 1) return {}
          throw new Error('Token already spent (11001)')
        },
      },
    })
    await Promise.all([reconcileGiftLinks(NOW, async () => 'UNSPENT'), reconcileGiftLinks(NOW, async () => 'UNSPENT')])
    // #401: the second run waits for the first, re-reads the link as Taken back, and never redeems again.
    expect(calls).toBe(1)
    expect((h.rows[0].link as { status: string }).status).toBe('reclaimed')
  })
  it('two settles at once, the loser answering first: Taken back still wins', async () => {
    const token = buildVoucherToken({ expiresAt: 1_900_000_000 }, [8]).token
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    let calls = 0
    vi.stubGlobal('window', {
      location: { origin: 'https://wallet.example' },
      TokenRedemption: {
        redeem: async () => {
          calls += 1
          // The winner's swap is slow to save; the loser's "already redeemed" comes back at once.
          if (calls === 1) return new Promise((resolve) => setTimeout(() => resolve({}), 30))
          throw new Error('This voucher was already redeemed in another session')
        },
      },
    })
    await Promise.all([reconcileGiftLinks(NOW, async () => 'UNSPENT'), reconcileGiftLinks(NOW, async () => 'UNSPENT')])
    expect((h.rows[0].link as { status: string }).status).toBe('reclaimed')
  })

  it('a settle cut off by the budget finishes in the background, and the next one has nothing left', async () => {
    const token = buildVoucherToken({ expiresAt: 1_900_000_000 }, [8]).token
    h.rows = [linkRow(0, 'outstanding', PAST)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    let release!: (s: ProofState) => void
    const slow = new Promise<ProofState>((r) => (release = r))
    const counts = await settleAndCountLinks(NOW, () => slow, 20)
    // Cut off: nothing written, the link still counts against its own cap.
    expect(counts).toEqual({ waiting: 0, expiredUnreturned: 1 })
    expect((h.rows[0].link as { status: string }).status).toBe('outstanding')
    release('UNSPENT')
    await vi.waitFor(() => expect((h.rows[0].link as { status: string }).status).toBe('reclaimed'))
    expect(h.redeemed).toHaveLength(1)
    await reconcileGiftLinks(NOW, async () => 'SPENT')
    expect((h.rows[0].link as { status: string }).status).toBe('reclaimed')
    expect(h.redeemed).toHaveLength(1)
  })
})

describe('#540 F1: one settle per Send screen', () => {
  const token = buildVoucherToken({ expiresAt: 1_900_000_000 }, [8]).token
  const NOW = 1_850_000_000_000

  it('sendGift does not settle again when the screen settled moments ago', async () => {
    h.rows = [linkRow(0, 'outstanding', 1_900_000_000)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    await settleAndCountLinks(NOW, async () => 'UNSPENT')
    h.deliverTo = linkPubOf(deriveLinkSecret(ID, 1))
    let asked = 0
    await sendGift({
      payer: PUB, merchant: {} as never, unit: 'EUR', amount: 100, x: 1_900_000_000, nowMs: NOW,
      state: async () => {
        asked++
        return 'UNSPENT'
      },
    })
    expect(asked).toBe(0)
    expect(h.sent).toHaveLength(1)
  })

  it('still judges the limit from fresh rows after a recent settle', async () => {
    await settleAndCountLinks(NOW, async () => 'UNSPENT')
    h.rows = Array.from({ length: MAX_OUTSTANDING_LINKS }, (_, i) => linkRow(i, 'outstanding', 1_900_000_000))
    await expect(
      sendGift({ payer: PUB, merchant: {} as never, unit: 'EUR', amount: 100, x: 1_900_000_000, nowMs: NOW, state: async () => 'UNSPENT' }),
    ).rejects.toThrow(tooManyLinksMessage())
  })

  it('settles again once the screen\'s settle is more than a minute old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(NOW)
      h.rows = [linkRow(0, 'outstanding', 1_900_000_000)]
      h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
      await settleAndCountLinks(NOW, async () => 'UNSPENT')
      vi.setSystemTime(NOW + 61_000)
      h.deliverTo = linkPubOf(deriveLinkSecret(ID, 1))
      let asked = 0
      await sendGift({
        payer: PUB, merchant: {} as never, unit: 'EUR', amount: 100, x: 1_900_000_000, nowMs: NOW,
        state: async () => {
          asked++
          return 'UNSPENT'
        },
      })
      expect(asked).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('#540 F8: the restore scan runs when it can find something', () => {
  const token = buildVoucherToken({}, [8]).token
  const NOW = 1_800_000_000_000

  it('probes four indices at a time', async () => {
    let inFlight = 0
    let peak = 0
    const probe = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return []
    }
    await restoreScan(PUB, probe, async () => 'UNSPENT', NOW)
    expect(RESTORE_PROBE_BATCH).toBe(4)
    expect(peak).toBe(RESTORE_PROBE_BATCH)
  })

  it('still slides the window and adopts in a batched scan', async () => {
    const seen: number[] = []
    const probe = async (secret: Uint8Array) => {
      for (let i = 0; i < 200; i++) {
        if (linkPubOf(deriveLinkSecret(ID, i)) === linkPubOf(secret)) {
          seen.push(i)
          return i === 15 ? [{ token, sentAt: 1_800_000_000 }] : []
        }
      }
      return []
    }
    expect(await restoreScan(PUB, probe, async () => 'UNSPENT', NOW)).toBe(1)
    expect(Math.max(...seen)).toBe(15 + RESTORE_GAP)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('scans on a fresh device, then not again the same day, then again a day later', async () => {
    const scan = vi.fn(async () => 0)
    await restoreScanIfDue(PUB, NOW, scan)
    expect(scan).toHaveBeenCalledTimes(1)
    await restoreScanIfDue(PUB, NOW + 60_000, scan)
    await restoreScanIfDue(PUB, NOW + RESTORE_SCAN_EVERY_MS - 1, scan)
    expect(scan).toHaveBeenCalledTimes(1)
    await restoreScanIfDue(PUB, NOW + RESTORE_SCAN_EVERY_MS, scan)
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('scans at once after logout or a wipe (the stamp is gone with the storage), and per account', async () => {
    const scan = vi.fn(async () => 0)
    await restoreScanIfDue(PUB, NOW, scan)
    await restoreScanIfDue('b'.repeat(64), NOW, scan)
    expect(scan).toHaveBeenCalledTimes(2)
    store.clear()
    await restoreScanIfDue(PUB, NOW + 60_000, scan)
    expect(scan).toHaveBeenCalledTimes(3)
  })
})
