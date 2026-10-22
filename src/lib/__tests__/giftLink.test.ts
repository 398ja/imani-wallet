import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip17 } from 'nostr-tools'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  combinedState,
  deriveLinkSecret,
  fetchGiftWraps,
  formatGiftLink,
  giftExclusion,
  giftExpiry,
  expiryChoices,
  GIFT_EXPIRY_MARGIN_S,
  GIFT_NOT_YET_COPY,
  GIFT_EXPIRES_SOON_COPY,
  giftTokensFrom,
  linkPubOf,
  parseGiftFragment,
  secretFromText,
  secretToText,
  tokenState,
  verifyGift,
  type GiftToken,
  type ProofState,
} from '../giftLink'
import { gatewayAnswers, resetGate } from './trustedMintKit'
import { buildLicenceVoucherToken, buildPlainToken, buildVoucherToken } from './voucherFixtures'

/**
 * Claim links phase 4 (imani-docs/wallet/spec-claim-links.md 3.3, 4.2, 4.3): the link key, the link, the gift
 * fetch, and every check made BEFORE anything is spent.
 */

const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
const ID = hexToBytes('11'.repeat(32))
const MINT = 'http://mint.test'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('link key derivation (spec 3.3)', () => {
  it('is HMAC-SHA256(identitySecret, "imani-gift-link/v1/" || i) mod n', () => {
    for (const i of [0, 1, 3, 41]) {
      const mac = BigInt('0x' + bytesToHex(hmac(sha256, ID, new TextEncoder().encode(`imani-gift-link/v1/${i}`))))
      expect(bytesToHex(deriveLinkSecret(ID, i))).toBe((mac % N).toString(16).padStart(64, '0'))
    }
  })

  it('fixed vectors (pinned, so a change to the rule is a visible break)', () => {
    expect(bytesToHex(deriveLinkSecret(ID, 0))).toMatchInlineSnapshot(`"6e5f6021bce4c3d64db08d3f662110e4f9c923e7945c7a38a8d77000cc5cbcb0"`)
    expect(linkPubOf(deriveLinkSecret(ID, 0))).toMatchInlineSnapshot(`"27baacf36ad5a776b7d5e05ec81105a8e4a597aeace6d09e694b958b9db13649"`)
    expect(bytesToHex(deriveLinkSecret(ID, 7))).toMatchInlineSnapshot(`"c30cd1ccd001f8355968766c5c3ff726f48e96a190eb5daa311048c25bd62212"`)
  })

  it('differs by index and by identity, and is deterministic', () => {
    expect(bytesToHex(deriveLinkSecret(ID, 0))).not.toBe(bytesToHex(deriveLinkSecret(ID, 1)))
    expect(bytesToHex(deriveLinkSecret(hexToBytes('22'.repeat(32)), 0))).not.toBe(bytesToHex(deriveLinkSecret(ID, 0)))
    expect(bytesToHex(deriveLinkSecret(ID, 5))).toBe(bytesToHex(deriveLinkSecret(ID, 5)))
  })

  it('refuses a negative or fractional index', () => {
    expect(() => deriveLinkSecret(ID, -1)).toThrow()
    expect(() => deriveLinkSecret(ID, 1.5)).toThrow()
  })
})

describe('the link (spec 2.3)', () => {
  const secret = deriveLinkSecret(ID, 2)
  const k = secretToText(secret)

  it('round-trips through the fragment, and names nothing in the path', () => {
    const link = formatGiftLink('https://wallet.example/some/path?q=1', secret, 1_800_000_000)!
    expect(link).toBe(`https://wallet.example/g#v=1&k=${k}&x=1800000000`)
    const parsed = parseGiftFragment(new URL(link).hash)
    expect(parsed).toMatchObject({ kind: 'gift', key: k, x: 1_800_000_000 })
    if (parsed.kind === 'gift') expect(bytesToHex(parsed.secret)).toBe(bytesToHex(secret))
  })

  it('is 43 base64url characters, canonical only', () => {
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(secretFromText(k)).not.toBeNull()
    // The two spare bits set: the same 32 bytes spelled differently is not accepted.
    const last = k.at(-1)!
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const twin = k.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1]
    expect(secretFromText(twin)).toBeNull()
  })

  it('rejects incomplete, wrong-version, wrong-length, duplicated or zero keys', () => {
    expect(parseGiftFragment('')).toEqual({ kind: 'incomplete' })
    expect(parseGiftFragment(`#v=2&k=${k}&x=1800000000`)).toEqual({ kind: 'incomplete' })
    expect(parseGiftFragment(`#v=1&k=${k.slice(1)}&x=1800000000`)).toEqual({ kind: 'incomplete' })
    expect(parseGiftFragment(`#v=1&k=${k}`)).toEqual({ kind: 'incomplete' })
    expect(parseGiftFragment(`#v=1&k=${k}&k=${k}&x=1800000000`)).toEqual({ kind: 'incomplete' })
    expect(parseGiftFragment(`#v=1&k=${'A'.repeat(43)}&x=1800000000`)).toEqual({ kind: 'incomplete' })
    expect(parseGiftFragment(`#v=1&k=${k}&x=soon`)).toEqual({ kind: 'incomplete' })
  })

  it('refuses a non-http origin', () => {
    expect(formatGiftLink('javascript:alert(1)', secret, 1_800_000_000)).toBeNull()
  })
})

describe('gift expiry = min(chosen, coupon expiry, 30 d) (pre-check build item 3, Q3)', () => {
  const now = Date.UTC(2026, 9, 13) // ms
  const s = now / 1000
  it('defaults to 7 days and offers 1, 7 or 30', () => {
    expect(giftExpiry(now, 7, [])).toBe(s + 7 * 86400)
    expect(giftExpiry(now, 1, [])).toBe(s + 86400)
    expect(giftExpiry(now, 30, [])).toBe(s + 30 * 86400)
    expect(giftExpiry(now, 400, [])).toBe(s + 7 * 86400)
  })
  it('ends at least 24 h before the coupon itself (#295 Q8)', () => {
    expect(giftExpiry(now, 30, [now + 3 * 86400_000])).toBe(s + 2 * 86400)
    expect(giftExpiry(now, 30, [undefined, now + 10 * 86400_000, now + 5 * 86400_000])).toBe(s + 4 * 86400)
    // A choice that fits is left alone.
    expect(giftExpiry(now, 7, [now + 8 * 86400_000])).toBe(s + 7 * 86400)
    expect(GIFT_EXPIRY_MARGIN_S).toBe(86400)
  })
})

describe('which expiry choices a coupon allows (#295 Q8)', () => {
  const now = Date.UTC(2026, 9, 13)
  const day = 86400_000
  it('offers 1, 7 and 30 days for a coupon with no expiry or a far one', () => {
    expect(expiryChoices(now, [])).toEqual([1, 7, 30])
    expect(expiryChoices(now, [undefined, now + 400 * day])).toEqual([1, 7, 30])
  })
  it('drops a choice that would end within 24 h of the coupon', () => {
    expect(expiryChoices(now, [now + 31 * day])).toEqual([1, 7, 30])
    expect(expiryChoices(now, [now + 31 * day - 1000])).toEqual([1, 7])
    expect(expiryChoices(now, [now + 8 * day])).toEqual([1, 7])
    expect(expiryChoices(now, [now + 5 * day])).toEqual([1])
    expect(expiryChoices(now, [now + 2 * day])).toEqual([1])
    expect(expiryChoices(now, [now + 2 * day - 1000])).toEqual([])
  })
  it('uses the soonest coupon', () => {
    expect(expiryChoices(now, [now + 100 * day, now + 5 * day])).toEqual([1])
  })
  it('every offered choice really keeps the margin', () => {
    for (const exp of [2, 3, 7.5, 8, 9, 30, 31, 32].map((d) => now + d * day)) {
      for (const d of expiryChoices(now, [exp])) {
        expect(giftExpiry(now, d, [exp]) * 1000 + GIFT_EXPIRY_MARGIN_S * 1000).toBeLessThanOrEqual(exp)
        expect(giftExpiry(now, d, [exp])).toBe(now / 1000 + d * 86400)
      }
    }
  })
})

describe('fetching the gift (spec 3.3 claim step 2, pre-check build item 2)', () => {
  const secret = deriveLinkSecret(ID, 4)
  const linkPub = linkPubOf(secret)

  it('queries wraps p-tagged to the link key, NO since, signed NIP-98 by the link key, no credentials', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://wallet.example' } })
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Response.json({ events: [] })
    }) as unknown as typeof fetch
    await fetchGiftWraps(secret, fetchImpl)
    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0].init.body))
    expect(body).toEqual({ kinds: [1059], pTags: [linkPub], limit: 50 })
    expect(body).not.toHaveProperty('since')
    expect(calls[0].init.credentials).toBe('omit')
    const auth = new Headers(calls[0].init.headers).get('authorization')!
    const event = JSON.parse(atob(auth.replace(/^Nostr /, '')))
    expect(event.pubkey).toBe(linkPub)
    expect(event.kind).toBe(27235)
    expect(calls[0].url).not.toContain(secretToText(secret))
  })

  it('unwraps with the link secret, ignores a transfer signature and wraps for other keys', async () => {
    const sender = generateSecretKey()
    const coupon = buildVoucherToken({}, [8]).token
    const ours = nip17.wrapEvent(sender, { publicKey: linkPub }, JSON.stringify({ type: 'cashu_token_transfer', token: coupon, sender_pubkey: getPublicKey(sender) }))
    const sig = nip17.wrapEvent(sender, { publicKey: linkPub }, JSON.stringify({ type: 'imani_transfer_signature', v: 1 }))
    const theirs = nip17.wrapEvent(sender, { publicKey: getPublicKey(generateSecretKey()) }, JSON.stringify({ type: 'cashu_token_transfer', token: buildPlainToken(MINT) }))
    const tokens = await giftTokensFrom(secret, [ours, sig, theirs] as never)
    expect(tokens.map((t) => t.token)).toEqual([coupon])
    expect(tokens[0].senderPubkey).toBe(getPublicKey(sender))
  })
})

describe('verifyGift: everything is checked before anything is spent (spec 3.3 claim step 4)', () => {
  const now = Date.UTC(2026, 9, 13)
  const x = Math.floor(now / 1000) + 86400
  const unspent = async (): Promise<ProofState> => 'UNSPENT'
  const gift = (token: string): GiftToken[] => [{ token, sentAt: 0 }]
  const MINT_TRUSTED = 'http://mint.test'

  beforeEach(async () => {
    await gatewayAnswers(MINT_TRUSTED)
  })
  afterEach(() => resetGate())

  it('accepts a signed voucher at a trusted mint, unspent, inside x', async () => {
    const { token } = buildVoucherToken({ expiresAt: Math.floor(now / 1000) + 30 * 86400 }, [8])
    const verdict = await verifyGift(gift(token), x, now, unspent)
    expect(verdict.kind).toBe('ok')
  })

  it('refuses a forged signature', async () => {
    const { token } = buildVoucherToken({ expiresAt: 0 }, [8], { faceValue: 99999 })
    expect((await verifyGift(gift(token), x, now, unspent)).kind).toBe('unverified')
  })

  it('refuses an untrusted mint without asking it anything', async () => {
    await gatewayAnswers('http://other-mint.test')
    const { token } = buildVoucherToken({ expiresAt: 0 }, [8])
    const state = vi.fn(unspent)
    expect((await verifyGift(gift(token), x, now, state)).kind).toBe('untrusted_mint')
    expect(state).not.toHaveBeenCalled()
  })

  it('refuses a licence or terminal credential as not money ("This link does not contain a voucher")', async () => {
    const meta = JSON.stringify({ kind: 'imani_licence', v: 1, lock_key: 'b'.repeat(64), product: 'annual' })
    const { token } = buildLicenceVoucherToken({ merchantMetadata: meta, expiresAt: 0 })
    expect((await verifyGift(gift(token), x, now, unspent)).kind).toBe('not_money')
  })

  it('refuses past x, and past the coupon\'s own expiry, before checking state', async () => {
    const { token } = buildVoucherToken({ expiresAt: 0 }, [8])
    const state = vi.fn(unspent)
    expect((await verifyGift(gift(token), Math.floor(now / 1000) - 1, now, state)).kind).toBe('expired')
    const lapsed = buildVoucherToken({ expiresAt: Math.floor(now / 1000) - 60 }, [8]).token
    expect((await verifyGift(gift(lapsed), x, now, state)).kind).toBe('expired')
    expect(state).not.toHaveBeenCalled()
  })

  it('reads spent or pending proofs as already claimed', async () => {
    const { token } = buildVoucherToken({ expiresAt: 0 }, [8])
    expect((await verifyGift(gift(token), x, now, async () => 'SPENT')).kind).toBe('claimed')
    expect((await verifyGift(gift(token), x, now, async () => 'PENDING')).kind).toBe('claimed')
    expect((await verifyGift(gift(token), x, now, async () => 'UNKNOWN')).kind).toBe('unreachable')
  })
})

describe('NUT-07 (tokenState)', () => {
  beforeEach(async () => {
    await gatewayAnswers(MINT)
  })

  it('sends only Y points to the trusted mint, never the token', async () => {
    const token = buildVoucherToken({}, [8, 2]).token
    const seen: string[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(url, String(init.body))
      return Response.json({ states: [{ state: 'UNSPENT' }, { state: 'UNSPENT' }] })
    }) as unknown as typeof fetch
    expect(await tokenState(token, fetchImpl)).toBe('UNSPENT')
    expect(seen[0]).toBe(`${MINT}/v1/checkstate`)
    expect(seen[1]).not.toContain(token)
    expect(JSON.parse(seen[1]).Ys).toHaveLength(2)
  })

  it('never asks an untrusted mint', async () => {
    await gatewayAnswers('http://other.test')
    const fetchImpl = vi.fn()
    expect(await tokenState(buildVoucherToken({}, [8]).token, fetchImpl as never)).toBe('UNKNOWN')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('combines: all spent is claimed, any unspent is still waiting', () => {
    expect(combinedState(['SPENT', 'SPENT'])).toBe('SPENT')
    expect(combinedState(['SPENT', 'UNSPENT'])).toBe('UNSPENT')
    expect(combinedState(['UNKNOWN', 'UNSPENT'])).toBe('UNKNOWN')
    expect(combinedState([])).toBe('UNKNOWN')
  })
})

describe('the picker (spec 4.2 step 2)', () => {
  const sender = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))
  it('excludes the sender\'s own stall, licences and locked vouchers', () => {
    const coupon = buildVoucherToken({}, [8])
    expect(giftExclusion(coupon.token, coupon.voucher.issuerId, sender)).toBeNull()
    expect(giftExclusion(coupon.token, sender, sender)).toBe('own_stall')
    const meta = JSON.stringify({ kind: 'imani_licence', v: 1, lock_key: 'b'.repeat(64), product: 'annual' })
    const licence = buildLicenceVoucherToken({ merchantMetadata: meta })
    expect(giftExclusion(licence.token, licence.voucher.issuerPublicKey, sender)).not.toBeNull()
    expect(giftExclusion(undefined, 'x', sender)).toBe('not_money')
  })

  it('excludes a coupon with a whole-number ratio other than 1 (cashu-voucher#59), in plain words', () => {
    for (const ratio of [2, 50, 700]) {
      const c = buildVoucherToken({ issuanceRatio: ratio }, [8])
      expect(giftExclusion(c.token, c.voucher.issuerId, sender)).toBe('not_yet')
    }
    for (const ratio of [1, 0.5, 50.5, 0.05611672278338945]) {
      const c = buildVoucherToken({ issuanceRatio: ratio }, [8])
      expect(giftExclusion(c.token, c.voucher.issuerId, sender)).toBeNull()
    }
    expect(GIFT_NOT_YET_COPY).not.toMatch(/ratio|issuance|mint|proof|token|verif|#59/i)
  })

  it('excludes a coupon that expires too soon to leave a day-long link and a day to take it back', () => {
    const now = 1_800_000_000_000
    const soon = buildVoucherToken({ expiresAt: now / 1000 + 2 * 86400 - 1 }, [8])
    const fine = buildVoucherToken({ expiresAt: now / 1000 + 2 * 86400 }, [8])
    expect(giftExclusion(soon.token, soon.voucher.issuerId, sender, now)).toBe('expires_soon')
    expect(giftExclusion(fine.token, fine.voucher.issuerId, sender, now)).toBeNull()
    expect(GIFT_EXPIRES_SOON_COPY).not.toMatch(/mint|proof|token|margin|x\b/i)
  })
})
