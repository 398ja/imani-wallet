import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip17 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * Review of #247: gift links under hostile or unlucky conditions.
 * - F1: anyone may gift-wrap junk to a link's PUBLIC key; it must not freeze the real coupon for the
 *   recipient, nor for the sender's reclaim and Take it back.
 * - F3: a link index must never be reused when this device lost its counter and rows (logout, a
 *   restored or second device, or before start-up's history restore has run).
 * - F4: a partly claimed multi-coupon gift still offers what is left.
 */

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  redeemed: [] as Array<{ token: string; source: string }>,
  sent: [] as Array<Record<string, unknown>>,
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
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({}),
  withCorrelation: async (_ids: unknown, run: (id: string) => unknown) => run('corr'),
}))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))
vi.mock('../pay', () => ({
  sendVouchers: async (args: Record<string, unknown>) => {
    h.sent.push(args)
    return { id: 's1', requested: 100, delivered: 100, parts: 1 }
  },
}))

import { deriveLinkSecret, giftTokensFrom, linkPubOf, secretToText, verifyGift, type GiftToken } from '../giftLink'
import { reconcileGiftLinks, redeemGiftTokens, restoreScan, sendGift, takeBack } from '../giftLinks'
import { gatewayAnswers, resetGate } from './trustedMintKit'
import { buildPlainToken, buildVoucherToken } from './voucherFixtures'

const ID = hexToBytes('33'.repeat(32))
const MINT = 'http://mint.test'
const store = new Map<string, string>()
const wrapTo = (linkPub: string, token: string, by = generateSecretKey()) =>
  nip17.wrapEvent(by, { publicKey: linkPub }, JSON.stringify({ type: 'cashu_token_transfer', token, sender_pubkey: getPublicKey(by) }))

beforeEach(async () => {
  store.clear()
  h.rows = []
  h.redeemed = []
  h.sent = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  await gatewayAnswers(MINT)
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('window', {
    location: { origin: 'https://wallet.example' },
    TokenRedemption: {
      redeem: async (token: string, opts: { source: string }) => {
        h.redeemed.push({ token, source: opts.source })
        return {}
      },
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetGate()
})

describe('F1: a third party wrap to the link key does not freeze the gift', () => {
  const now = Date.UTC(2026, 9, 13)
  const x = Math.floor(now / 1000) + 86400

  it('the recipient is offered the genuine coupon, and Add redeems only that one', async () => {
    const secret = deriveLinkSecret(ID, 0)
    const real = buildVoucherToken({ expiresAt: 0 }, [8]).token
    const junk = [
      buildPlainToken('http://evil.example'),
      buildVoucherToken({ expiresAt: 0 }, [8], { faceValue: 1 }).token, // forged signature
      buildPlainToken(MINT),
    ]
    const tokens = await giftTokensFrom(secret, [real, ...junk].map((t) => wrapTo(linkPubOf(secret), t)) as never)
    expect(tokens).toHaveLength(4)
    const verdict = await verifyGift(tokens, x, now, async () => 'UNSPENT')
    expect(verdict.kind).toBe('ok')
    expect(verdict.kind === 'ok' && verdict.tokens.map((t) => t.token)).toEqual([real])
  })

  it('a real but spent or lapsed coupon wrapped by someone else is noise too', async () => {
    const secret = deriveLinkSecret(ID, 1)
    const real = buildVoucherToken({ expiresAt: 0 }, [8]).token
    const spent = buildVoucherToken({ expiresAt: 0, voucherId: 'bbbbbbbb-0000-4000-8000-000000000001' }, [4]).token
    const lapsed = buildVoucherToken({ expiresAt: Math.floor(now / 1000) - 60, voucherId: 'bbbbbbbb-0000-4000-8000-000000000002' }, [4]).token
    const tokens = await giftTokensFrom(secret, [real, spent, lapsed].map((t) => wrapTo(linkPubOf(secret), t)) as never)
    const verdict = await verifyGift(tokens, x, now, async (t) => (t === spent ? 'SPENT' : 'UNSPENT'))
    expect(verdict.kind === 'ok' && verdict.tokens.map((t) => t.token)).toEqual([real])
  })

  it('a link with ONLY junk still gets the right refusal', async () => {
    const secret = deriveLinkSecret(ID, 2)
    const tokens = await giftTokensFrom(secret, [wrapTo(linkPubOf(secret), buildPlainToken('http://evil.example'))] as never)
    expect((await verifyGift(tokens, x, now, async () => 'UNSPENT')).kind).not.toBe('ok')
  })

  it('the sender still reclaims the genuine coupon after x, and Take it back is not refused as held', async () => {
    const secret = deriveLinkSecret(ID, 3)
    const real = buildVoucherToken({ expiresAt: 0 }, [8]).token
    const junk = buildPlainToken('http://evil.example')
    const k = secretToText(secret)
    h.rows = [{ id: 'sent:g', type: 'sent', timestamp: 1, link: { k, i: 3, x: 1_800_000_000, status: 'outstanding' } }]
    const wraps = [real, junk].map((t) => wrapTo(linkPubOf(secret), t))
    vi.stubGlobal('fetch', async () => Response.json({ events: wraps }))
    const out = await reconcileGiftLinks(1_800_000_001_000, async (t) => (t === real ? 'UNSPENT' : 'UNKNOWN'))
    expect(out).toEqual({ claimed: 0, reclaimed: 1 })
    expect(h.redeemed).toEqual([{ token: real, source: 'gift_link_reclaim' }])

    h.rows = [{ id: 'sent:h', type: 'sent', timestamp: 1, link: { k, i: 3, x: 2_000_000_000, status: 'outstanding' } }]
    h.redeemed = []
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('/v1/checkstate') ? Response.json({ states: [{ state: 'UNSPENT' }] }) : Response.json({ events: wraps }),
    )
    expect((await takeBack(k)).kind).toBe('ok')
    expect(h.redeemed).toEqual([{ token: real, source: 'gift_link_reclaim' }])
  })
})

describe('F3: a link index is never reused after this device lost its counter and rows', () => {
  it('skips an index whose link key already holds a wrap, and reserves it', async () => {
    const used = [0, 1].map((i) => linkPubOf(deriveLinkSecret(ID, i)))
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { pTags: string[] }
      return Response.json({ events: used.includes(body.pTags[0]) ? [wrapTo(body.pTags[0], buildPlainToken(MINT))] : [] })
    })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const p = sendGift({ payer: 'b'.repeat(64), merchant: {} as never, unit: 'EUR', amount: 100, x: 1_900_000_000 })
    await vi.runAllTimersAsync()
    const out = await p
    vi.useRealTimers()
    expect((h.sent[0].link as { i: number }).i).toBe(2)
    expect(out.link).toContain(`k=${secretToText(deriveLinkSecret(ID, 2))}`)
  })

  it('two sends started together (the probe is an await) never derive the same index', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.stubGlobal('fetch', async () => {
      await gate
      return Response.json({ events: [] })
    })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const one = sendGift({ payer: 'b'.repeat(64), merchant: {} as never, unit: 'EUR', amount: 100, x: 1_900_000_000 })
    const two = sendGift({ payer: 'b'.repeat(64), merchant: {} as never, unit: 'EUR', amount: 100, x: 1_900_000_000 })
    await Promise.resolve()
    release()
    await vi.runAllTimersAsync()
    await Promise.all([one, two])
    vi.useRealTimers()
    const idx = h.sent.map((s) => (s.link as { i: number }).i)
    expect(new Set(idx).size).toBe(2)
  })

  it('refuses the send, before anything moves, when it cannot tell whether the key is free', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }))
    await expect(sendGift({ payer: 'b'.repeat(64), merchant: {} as never, unit: 'EUR', amount: 100, x: 1_900_000_000 })).rejects.toThrow(
      /Nothing has been sent/,
    )
    expect(h.sent).toHaveLength(0)
  })
})

describe('second check of the fix (review of #247)', () => {
  const now = Date.UTC(2026, 9, 13)
  const x = Math.floor(now / 1000) + 86400

  it('the restore scan adopts the genuine link even when a third party wrapped junk to it', async () => {
    const real = buildVoucherToken({ expiresAt: 0 }, [8]).token
    const junk = buildPlainToken('http://evil.example')
    const target = linkPubOf(deriveLinkSecret(ID, 0))
    const probe = async (secret: Uint8Array) =>
      linkPubOf(secret) === target ? [real, junk].map((token) => ({ token, sentAt: 1_800_000_000 })) : []
    // tokenState never asks a mint this wallet does not trust: the junk reads UNKNOWN.
    const adopted = await restoreScan('b'.repeat(64), probe, async (t) => (t === real ? 'UNSPENT' : 'UNKNOWN'), now)
    expect(adopted).toBe(1)
    expect(h.rows).toHaveLength(1)
    expect(h.rows[0]).toMatchObject({ type: 'sent', link: { i: 0, status: 'outstanding' } })
  })

  it('a coupon whose state cannot be read keeps the whole gift waiting (never a partial Add)', async () => {
    const stall = hexToBytes('44'.repeat(32))
    const a = buildVoucherToken({ expiresAt: 0, voucherId: 'cccccccc-0000-4000-8000-000000000001' }, [8], {}, stall).token
    const b = buildVoucherToken({ expiresAt: 0, voucherId: 'cccccccc-0000-4000-8000-000000000002' }, [4], {}, stall).token
    const tokens: GiftToken[] = [a, b].map((token) => ({ token, sentAt: 0 }))
    expect((await verifyGift(tokens, x, now, async (t) => (t === a ? 'UNSPENT' : 'UNKNOWN'))).kind).toBe('unreachable')
  })

  // Residual (follow-up): a VALID coupon of another stall wrapped to the link key still makes the
  // recipient's prompt refuse ("could not verify"), because the wallet cannot tell which stall the
  // sender meant. Pinned so the check is not dropped silently; the sender can still take it back.
  it('coupons of two stalls are refused for the recipient, and Take it back still works', async () => {
    const real = buildVoucherToken({ expiresAt: 0 }, [8], {}, hexToBytes('44'.repeat(32))).token
    const other = buildVoucherToken({ expiresAt: 0, voucherId: 'dddddddd-0000-4000-8000-000000000001' }, [4], {}, hexToBytes('55'.repeat(32))).token
    const secret = deriveLinkSecret(ID, 7)
    const wraps = [real, other].map((t) => wrapTo(linkPubOf(secret), t))
    const tokens = await giftTokensFrom(secret, wraps as never)
    expect((await verifyGift(tokens, x, now, async () => 'UNSPENT')).kind).toBe('unverified')

    const k = secretToText(secret)
    h.rows = [{ id: 'sent:m', type: 'sent', timestamp: 1, link: { k, i: 7, x: 2_000_000_000, status: 'outstanding' } }]
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('/v1/checkstate') ? Response.json({ states: [{ state: 'UNSPENT' }] }) : Response.json({ events: wraps }),
    )
    expect((await takeBack(k)).kind).toBe('ok')
    expect(h.redeemed.map((r) => r.token)).toContain(real)
  })

  // A third party re-uses the SIGNED secret of a voucher it holds (issuer signature valid, trusted
  // mint, NUT-07 UNSPENT) with a garbage mint signature `C`. It passes every client-side check, and
  // the mint refuses it at redeem. Wrapped FIRST, it must not stop the genuine coupon from being
  // added or taken back (one idle voucher could otherwise freeze every link it is wrapped to).
  it('an unredeemable decoy wrapped first does not stop the genuine coupon being added or taken back', async () => {
    const stall = hexToBytes('44'.repeat(32))
    const decoy = buildVoucherToken({ expiresAt: 0, voucherId: 'eeeeeeee-0000-4000-8000-000000000001' }, [4], {}, stall).token
    const real = buildVoucherToken({ expiresAt: 0, voucherId: 'eeeeeeee-0000-4000-8000-000000000002' }, [8], {}, stall).token
    const redeem = window.TokenRedemption!.redeem
    ;(window as unknown as { TokenRedemption: { redeem: typeof redeem } }).TokenRedemption.redeem = async (token, opts) => {
      if (token === decoy) throw new Error('mint: could not verify proofs (10003)')
      return redeem(token, opts)
    }
    const secret = deriveLinkSecret(ID, 9)
    const wraps = [decoy, real].map((t) => wrapTo(linkPubOf(secret), t))
    const tokens = await giftTokensFrom(secret, wraps as never)
    const verdict = await verifyGift(tokens, x, now, async () => 'UNSPENT')
    expect(verdict.kind).toBe('ok')
    await redeemGiftTokens(verdict.kind === 'ok' ? verdict.tokens : [], 'gift_link')
    expect(h.redeemed).toEqual([{ token: real, source: 'gift_link' }])

    h.redeemed = []
    const k = secretToText(secret)
    h.rows = [{ id: 'sent:d', type: 'sent', timestamp: 1, link: { k, i: 9, x: 2_000_000_000, status: 'outstanding' } }]
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('/v1/checkstate') ? Response.json({ states: [{ state: 'UNSPENT' }] }) : Response.json({ events: wraps }),
    )
    await takeBack(k)
    expect(h.redeemed).toEqual([{ token: real, source: 'gift_link_reclaim' }])
  })
})

describe('F4: a partly claimed gift offers what is left', () => {
  it('after one of two coupons was added, the other is still offered, at its own face', async () => {
    const now = Date.UTC(2026, 9, 13)
    const x = Math.floor(now / 1000) + 86400
    const stall = hexToBytes('44'.repeat(32))
    const a = buildVoucherToken({ expiresAt: 0, voucherId: 'aaaaaaaa-0000-4000-8000-000000000001', faceValue: 800 }, [8], {}, stall).token
    const b = buildVoucherToken({ expiresAt: 0, voucherId: 'aaaaaaaa-0000-4000-8000-000000000002', faceValue: 400 }, [4], {}, stall).token
    const tokens: GiftToken[] = [a, b].map((token) => ({ token, sentAt: 0 }))
    const whole = await verifyGift(tokens, x, now, async () => 'UNSPENT')
    const onlyB = await verifyGift([tokens[1]], x, now, async () => 'UNSPENT')
    const verdict = await verifyGift(tokens, x, now, async (t) => (t === a ? 'SPENT' : 'UNSPENT'))
    expect(verdict.kind).toBe('ok')
    expect(verdict.kind === 'ok' && verdict.tokens.map((t) => t.token)).toEqual([b])
    // The prompt shows what is left, not the whole gift.
    expect(verdict.kind === 'ok' && onlyB.kind === 'ok' && verdict.summary.faceMinor).toBe(onlyB.kind === 'ok' && onlyB.summary.faceMinor)
    expect(whole.kind === 'ok' && whole.tokens).toHaveLength(2)
    expect((await verifyGift(tokens, x, now, async () => 'SPENT')).kind).toBe('claimed')
  })
})
