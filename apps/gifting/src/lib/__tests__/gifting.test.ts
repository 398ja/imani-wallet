/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { isNip05, normaliseRecipientHandle, parseShopHandle } from '../handle'
import { loadShop, robotsFor, SHOP_COPY, type ShopDeps } from '../shop'
import {
  claimDeadline,
  draftMatches,
  draftRequest,
  EMPTY_FORM,
  isEmail,
  isExpired,
  keep,
  messageProblem,
  recall,
  termsVersion,
  toMinorUnits,
  validate,
  type Draft,
  type GiftForm,
} from '../draft'
import { newGiftSecrets, returnLink, seal, unseal } from '../gift'
import { ApiError, giftingApi } from '../api'
import { connect } from '../signer'
import type { MerchantProfile } from '@wallet/lib/merchant'

const STALL = 'a'.repeat(64)
const BOB = 'b'.repeat(64)

describe('parseShopHandle (owner edit 1)', () => {
  it('reads a bare name as a handle on the default domain', () => {
    expect(parseShopHandle('alice', 'imani.casa')).toEqual({ kind: 'ok', nip05: 'alice@imani.casa', canonical: 'alice', redirect: false })
  })
  it('redirects the full default-domain form to the bare one', () => {
    expect(parseShopHandle('alice@imani.casa', 'imani.casa')).toMatchObject({ canonical: 'alice', redirect: true })
    expect(parseShopHandle('alice%40imani.casa', 'imani.casa')).toMatchObject({ nip05: 'alice@imani.casa', redirect: true })
  })
  it('accepts another domain as a full NIP-05, URL-encoded or not', () => {
    expect(parseShopHandle('alice%40example.com', 'imani.casa')).toEqual({ kind: 'ok', nip05: 'alice@example.com', canonical: 'alice@example.com', redirect: false })
    expect(parseShopHandle('alice@example.com', 'imani.casa')).toMatchObject({ redirect: false })
  })
  it('lower-cases and redirects to the lower-case form', () => {
    expect(parseShopHandle('Alice', 'imani.casa')).toMatchObject({ nip05: 'alice@imani.casa', canonical: 'alice', redirect: true })
  })
  it('honours a configured default domain', () => {
    expect(parseShopHandle('bob', 'staging.398ja.xyz')).toMatchObject({ nip05: 'bob@staging.398ja.xyz' })
  })
  it.each(['', undefined, 'a b', 'al!ce', 'alice@', '@imani.casa', 'a@b', 'a@@b.com', '%E0%A4%A', 'x'.repeat(65), 'npub1abc@', '<script>'])(
    'rejects %s',
    (raw) => {
      expect(parseShopHandle(raw as string | undefined, 'imani.casa')).toEqual({ kind: 'invalid' })
    },
  )
  it('rejects a hex pubkey on a domain-less form? no: a 64-hex bare name is a valid local part, resolved like any handle', () => {
    // There is no hexpub URL: a hex string is looked up as a NAME, and is not found.
    expect(parseShopHandle(STALL, 'imani.casa')).toMatchObject({ nip05: `${STALL}@imani.casa` })
  })
  it('keeps _@domain in full form', () => {
    expect(parseShopHandle('_@imani.casa', 'imani.casa')).toMatchObject({ canonical: '_@imani.casa', redirect: false })
  })
})

describe('recipient handles', () => {
  it('normalises', () => {
    expect(normaliseRecipientHandle(' @Bob@Example.COM ', 'imani.casa')).toBe('bob@example.com')
    expect(normaliseRecipientHandle('bob', 'imani.casa')).toBe('bob@imani.casa')
    expect(normaliseRecipientHandle('', 'imani.casa')).toBeNull()
    expect(normaliseRecipientHandle('bob@', 'imani.casa')).toBeNull()
  })
  it('isNip05', () => {
    expect(isNip05('_@example.com')).toBe(true)
    expect(isNip05('a@-x.com')).toBe(false)
  })
})

const record = (over: Partial<MerchantProfile> = {}): MerchantProfile => ({
  pubkey: STALL,
  active: true,
  categories: [],
  issuanceCurrency: 'EUR',
  voucherValidityDays: 90,
  acceptsCards: true,
  updatedAt: 0,
  eventAt: 100,
  ...over,
})

function deps(over: Partial<ShopDeps> = {}): ShopDeps {
  return {
    resolve: vi.fn(async () => STALL),
    record: vi.fn(async () => record()),
    branding: vi.fn(async () => ({ name: 'Alice’s Bakery' })),
    ...over,
  }
}

describe('loadShop: the stall-page edge cases', () => {
  it('malformed handle: invalid, nothing fetched', async () => {
    const d = deps()
    expect(await loadShop('a b', d)).toEqual({ kind: 'invalid' })
    expect(d.resolve).not.toHaveBeenCalled()
  })
  it('non-canonical: redirect before any lookup', async () => {
    const d = deps()
    expect(await loadShop('alice@imani.casa', d)).toEqual({ kind: 'redirect', to: '/shop/alice' })
    expect(d.resolve).not.toHaveBeenCalled()
  })
  it('unknown handle: not found, not retryable', async () => {
    expect(await loadShop('nobody', deps({ resolve: async () => null }))).toEqual({ kind: 'not-found', retryable: false })
  })
  it('resolver unreachable: same words, with a retry', async () => {
    expect(await loadShop('alice', deps({ resolve: async () => { throw new Error('down') } }))).toEqual({ kind: 'not-found', retryable: true })
  })
  it('handle resolves to a key with no stall record (or the relay failed): not found', async () => {
    expect(await loadShop('alice', deps({ record: async () => null }))).toMatchObject({ kind: 'not-found' })
    expect(await loadShop('alice', deps({ record: async () => { throw new Error('relay') } }))).toMatchObject({ kind: 'not-found' })
  })
  it('acceptsCards missing or not literally true: no form', async () => {
    for (const acceptsCards of [undefined, false]) {
      const s = await loadShop('alice', deps({ record: async () => record({ acceptsCards }) }))
      expect(s.kind).toBe('no-cards')
    }
  })
  it('paused stall: not selling', async () => {
    const s = await loadShop('alice', deps({ record: async () => record({ active: false }) }))
    expect(s.kind).toBe('paused')
    if (s.kind === 'paused') expect(SHOP_COPY.paused(s.shop.name)).toBe('Alice’s Bakery isn\'t selling vouchers right now.')
  })
  it('a card stall: the form, with the resolved pubkey', async () => {
    const s = await loadShop('alice', deps())
    expect(s).toMatchObject({ kind: 'ok', shop: { pubkey: STALL, nip05: 'alice@imani.casa', name: 'Alice’s Bakery' } })
  })
  it('names the shop by handle when it has no kind-0 name, never by key', async () => {
    const s = await loadShop('alice', deps({ branding: async () => ({}) }))
    expect(s.kind === 'ok' && s.shop.name).toBe('alice@imani.casa')
  })
  it('G1: indexable only for a literal giftingIndexable: true on a card stall', async () => {
    expect(robotsFor(await loadShop('alice', deps()))).toBe('noindex')
    expect(robotsFor(await loadShop('alice', deps({ record: async () => record({ giftingIndexable: true }) })))).toBe('index')
    expect(robotsFor(await loadShop('alice', deps({ record: async () => record({ giftingIndexable: true, acceptsCards: false }) })))).toBe('noindex')
  })
})

const form = (over: Partial<GiftForm> = {}): GiftForm => ({ ...EMPTY_FORM, amount: '20', handle: 'bob@example.com', buyerEmail: 'me@example.com', ...over })

describe('form validation', () => {
  it('amounts: rejects rather than rounds', () => {
    expect(toMinorUnits('25.00')).toBe(2500)
    expect(toMinorUnits('25.999')).toBeNull()
    expect(toMinorUnits('0')).toBeNull()
    expect(toMinorUnits('-5')).toBeNull()
    expect(toMinorUnits('500', 0)).toBe(500)
    expect(toMinorUnits('5.5', 0)).toBeNull()
  })
  it('every sender gives an email, signed in or not (G15)', () => {
    for (const deliver of ['handle', 'email'] as const) {
      for (const signedIn of [false, true]) {
        expect(validate(form({ deliver, buyerEmail: '' }), { signedIn }).buyerEmail).toBe("We need your email to tell you when it's claimed.")
        expect(validate(form({ deliver, buyerEmail: 'me@example.com' }), { signedIn }).buyerEmail).toBeUndefined()
      }
    }
  })
  it('handle to the stall itself is refused', () => {
    expect(validate(form({ handle: 'alice' }), { signedIn: false, stallNip05: 'alice@imani.casa' }).handle).toMatch(/can't send/)
  })
  it('email syntax', () => {
    expect(isEmail('bob@example.com')).toBe(true)
    expect(isEmail('bob@exmaple')).toBe(false)
    expect(validate(form({ deliver: 'email', email: 'nope' }), { signedIn: false }).email).toBeDefined()
  })
  it('message: plain text, capped, no links', () => {
    expect(messageProblem('Happy birthday!')).toBeNull()
    expect(messageProblem('x'.repeat(281))).toMatch(/280/)
    expect(messageProblem('see https://evil.example')).toMatch(/links/)
    expect(messageProblem('www.evil')).toMatch(/links/)
    expect(messageProblem('go to evil.com now')).toMatch(/links/)
    expect(messageProblem('<b>hi</b>')).toMatch(/plain/)
  })
})

describe('draft pinning', () => {
  const ctx = { stallPubkey: STALL, stallHandle: 'alice@imani.casa', currency: 'eur', terms: 'EUR:90:100', refundPubkey: BOB, signedIn: false }
  it('builds the request from the form, normalised', () => {
    const req = draftRequest(form({ handle: '@Bob@Example.com', message: '  hi  ' }), ctx)
    expect(req).toMatchObject({ amountMinor: 2000, currency: 'EUR', delivery: { kind: 'handle', handle: 'bob@example.com', refundPubkey: BOB }, message: 'hi', buyerEmail: 'me@example.com' })
    expect(req.delivery.sealed).toBeUndefined()
  })
  it('email gifts carry the seal and no handle; a signed-in sender still sends their email (G15)', () => {
    const e = draftRequest(form({ deliver: 'email', email: 'bob@example.com' }), { ...ctx, sealed: 'v1.x.y' })
    expect(e.delivery).toEqual({ kind: 'email', email: 'bob@example.com', refundPubkey: BOB, sealed: 'v1.x.y' })
    const s = draftRequest(form({ deliver: 'handle', handle: 'bob@example.com' }), { ...ctx, signedIn: true })
    expect(s.buyerEmail).toBe('me@example.com')
  })
  const draft = (over: Partial<Draft['delivery']> = {}, top: Partial<Draft> = {}): Draft => ({
    draftId: 'd1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    stallPubkey: STALL,
    amountMinor: 2000,
    currency: 'EUR',
    delivery: { kind: 'handle', recipientPubkey: BOB, refundPubkey: BOB, claimWindowDays: 30, ...over },
    ...top,
  })
  it('accepts a draft that pins what was reviewed', () => {
    expect(draftMatches(draft(), draftRequest(form(), ctx), BOB)).toBe(true)
  })
  it('refuses a draft that pinned another recipient, amount, stall, currency or refund key', () => {
    const req = draftRequest(form(), ctx)
    expect(draftMatches(draft({ recipientPubkey: 'c'.repeat(64) }), req, BOB)).toBe(false)
    expect(draftMatches(draft({}, { amountMinor: 1 }), req)).toBe(false)
    expect(draftMatches(draft({}, { stallPubkey: BOB }), req)).toBe(false)
    expect(draftMatches(draft({}, { currency: 'USD' }), req)).toBe(false)
    expect(draftMatches(draft({ refundPubkey: STALL }), req)).toBe(false)
    expect(draftMatches(draft({ kind: 'email' }), req)).toBe(false)
  })
  it('expiry: a 30-minute draft is never paid once expired', () => {
    expect(isExpired({ expiresAt: new Date(Date.now() - 1).toISOString() })).toBe(true)
    expect(isExpired({ expiresAt: 'garbage' })).toBe(true)
    expect(isExpired(draft())).toBe(false)
  })
  it('terms version moves with currency, validity and the record', () => {
    expect(termsVersion(record())).toBe('EUR:90:100')
    expect(termsVersion(record({ voucherValidityDays: 30 }))).not.toBe(termsVersion(record()))
  })
  it('G11: 30 days, capped by voucher expiry minus 24h', () => {
    const t = Date.UTC(2026, 0, 1)
    expect(claimDeadline(t, 90).getTime()).toBe(t + 30 * 86_400_000)
    expect(claimDeadline(t, 10).getTime()).toBe(t + 9 * 86_400_000)
    expect(claimDeadline(t, 0).getTime()).toBe(t + 30 * 86_400_000)
  })
  it('keeps the form across sign-in and Edit, and survives blocked storage', () => {
    const store = new Map<string, string>()
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    keep('alice', { form: form({ message: 'hi' }), draftId: 'd1' }, s)
    expect(recall('alice', s)).toMatchObject({ form: { message: 'hi', amount: '20' }, draftId: 'd1' })
    expect(recall('bob', s)).toBeNull()
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(() => keep('alice', { form: form() }, broken)).not.toThrow()
    expect(recall('alice', broken)).toBeNull()
  })
})

describe('gift secrets (G3, G4, G8)', () => {
  it('signed-in buyer: refund key is the wallet key, no secret made here', () => {
    expect(newGiftSecrets('handle', BOB)).toEqual({ linkSecret: undefined, refundPubkey: BOB })
  })
  it('guest: a fresh R whose pubkey is the refund key; email gets a link secret', () => {
    const g = newGiftSecrets('email', null)
    expect(getPublicKey(hexToBytes(g.refundSecret!))).toBe(g.refundPubkey)
    expect(g.linkSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(newGiftSecrets('handle', null).linkSecret).toBeUndefined()
  })
  it('seals to the issuer only, bound to the purchase', () => {
    const issuer = generateSecretKey()
    const sealed = seal(getPublicKey(issuer), { stallPubkey: STALL, amountMinor: 2000, recipient: 'bob@example.com' }, { linkSecret: 'ff'.repeat(32) })
    expect(sealed).not.toContain('ff'.repeat(32))
    expect(unseal(issuer, sealed)).toMatchObject({ stallPubkey: STALL, amountMinor: 2000, recipient: 'bob@example.com', linkSecret: 'ff'.repeat(32) })
    expect(() => unseal(generateSecretKey(), sealed)).toThrow()
    expect(() => unseal(issuer, 'v2.x.y')).toThrow()
  })
  it('return link keeps R in the fragment', () => {
    const u = new URL(returnLink('https://imani.casa/', 'ab'.repeat(32)))
    expect(u.pathname).toBe('/gift-return')
    expect(u.search).toBe('')
    expect(u.hash).toBe(`#r=${'ab'.repeat(32)}`)
  })
})

describe('api', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  it('pay posts only the draft id', async () => {
    const f = vi.fn(async () => json(200, { checkoutUrl: 'https://stripe/x', reference: 'd1' }))
    await giftingApi(f as unknown as typeof fetch).pay('d1')
    const [, init] = (f.mock.calls[0] as unknown as [string, RequestInit])
    expect(JSON.parse(init.body as string)).toEqual({ draftId: 'd1' })
  })
  it('shows payment-adapter refusals verbatim and keeps the code', async () => {
    const api = giftingApi((async () => json(409, { error: 'this stall cannot accept card payments yet' })) as unknown as typeof fetch)
    await expect(api.pay('d1')).rejects.toMatchObject({ message: 'this stall cannot accept card payments yet', status: 409 })
    const api2 = giftingApi((async () => json(410, { error: 'DRAFT_EXPIRED' })) as unknown as typeof fetch)
    await expect(api2.pay('d1')).rejects.toMatchObject({ code: 'DRAFT_EXPIRED', message: 'This took a while, so we checked again.' })
  })
  it('unreachable: nothing was charged', async () => {
    const api = giftingApi((async () => { throw new TypeError('net') }) as unknown as typeof fetch)
    await expect(api.pay('d1')).rejects.toBeInstanceOf(ApiError)
    await expect(api.pay('d1')).rejects.toMatchObject({ message: 'Could not reach the payment service. Nothing was charged.' })
  })
  it('signs a draft with NIP-98 over the exact body when signed in, not for guests', async () => {
    const f = vi.fn(async () => json(201, {}))
    const signer = { pubkey: BOB, signEvent: vi.fn(async (t: unknown) => ({ ...(t as object), pubkey: BOB, sig: 's', id: 'i' })) }
    const req = draftRequest(form({ deliver: 'handle', handle: 'bob@example.com' }), { stallPubkey: STALL, stallHandle: 'alice@imani.casa', currency: 'EUR', terms: 't', refundPubkey: BOB, signedIn: true })
    await giftingApi(f as unknown as typeof fetch).createDraft(req, signer)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    const auth = (init.headers as Record<string, string>).Authorization
    const event = JSON.parse(atob(auth.replace('Nostr ', ''))) as { kind: number; tags: string[][] }
    expect(event.kind).toBe(27235)
    expect(event.tags).toContainEqual(['u', url])
    expect(event.tags).toContainEqual(['method', 'POST'])
    await giftingApi(f as unknown as typeof fetch).createDraft(req, null)
    expect((f.mock.calls[1] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty('Authorization')
  })
  it('resolve: 404 is "no such handle", a 5xx is "could not ask"', async () => {
    expect(await giftingApi((async () => json(404, {})) as unknown as typeof fetch).resolve('x@y.com')).toBeNull()
    await expect(giftingApi((async () => json(503, {})) as unknown as typeof fetch).resolve('x@y.com')).rejects.toThrow()
    expect(await giftingApi((async () => json(200, { hex_pubkey: STALL.toUpperCase() })) as unknown as typeof fetch).resolve('x@y.com')).toBe(STALL)
    expect(await giftingApi((async () => json(200, { hex_pubkey: 'nope' })) as unknown as typeof fetch).resolve('x@y.com')).toBeNull()
  })
})

describe('cross-origin sign-in (NAP 0002)', () => {
  it('asks the wallet origin for kind 27235 addressed to this origin only', async () => {
    const connectImpl = vi.fn(async () => ({
      info: { grantId: 'g', pubkey: BOB, kinds: [27235], audiences: [window.location.origin], expiresAt: 9e9 },
      signer: { signEvent: vi.fn(), getNpub: () => '' },
      isActive: () => true,
      onEnd: () => () => {},
      disconnect: () => {},
    }))
    const s = await connect({ connectImpl: connectImpl as never, expectedPubkey: BOB })
    expect(s.pubkey).toBe(BOB)
    expect(connectImpl).toHaveBeenCalledWith(expect.objectContaining({ kinds: [27235], audiences: [window.location.origin], expectedPubkey: BOB }))
  })
})

describe('displayHandle: a handle as a person reads it, never a key', () => {
  it('is @name on the site\'s own domain, the full handle elsewhere', async () => {
    const { displayHandle } = await import('../handle')
    expect(displayHandle('alice@imani.casa', 'imani.casa')).toBe('@alice')
    expect(displayHandle('alice@example.com', 'imani.casa')).toBe('alice@example.com')
    expect(displayHandle('_@imani.casa', 'imani.casa')).toBe('_@imani.casa')
    expect(displayHandle('alice@imani.casa', '')).toBe('alice@imani.casa')
  })
})
