/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { isNip05, parseShopHandle } from '../handle'
import { codeGiftAvailable, codeGiftsEnabled, loadShop, robotsFor, SHOP_COPY, shopHost, type ShopDeps } from '../shop'
import { parseOnlineShop } from '@wallet/lib/onlineShop'
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

describe('nip05', () => {
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

const SHOP_FIELD = { url: 'https://www.olive.example/store', redeem_key: 'ab'.repeat(32), platform: 'woocommerce', since: 1767000000 }

describe('code gifts: only for a stall whose online shop takes checkout codes', () => {
  const withShop = record({ onlineShop: parseOnlineShop(SHOP_FIELD) ?? undefined })
  it('the build switch is off unless literally on', () => {
    expect(codeGiftsEnabled(undefined)).toBe(false)
    expect(codeGiftsEnabled('true')).toBe(false)
    expect(codeGiftsEnabled(' ON ')).toBe(true)
  })
  it('offered only with a well-formed online_shop on the stall record, and the switch on', () => {
    expect(codeGiftAvailable({ record: withShop }, true)).toBe(true)
    expect(codeGiftAvailable({ record: withShop }, false)).toBe(false)
    expect(codeGiftAvailable({ record: record() }, true)).toBe(false)
    // A malformed field is no shop (fail closed, contract §4), so no choice either.
    const bad = record({ onlineShop: parseOnlineShop({ ...SHOP_FIELD, url: 'http://olive.example' }) ?? undefined })
    expect(codeGiftAvailable({ record: bad }, true)).toBe(false)
  })
  it('names the shop by its host, never its key', () => {
    expect(shopHost({ record: withShop })).toBe('olive.example')
    expect(shopHost({ record: record() })).toBeNull()
  })
})

const form = (over: Partial<GiftForm> = {}): GiftForm => ({ ...EMPTY_FORM, amount: '20', email: 'bob@example.com', buyerEmail: 'me@example.com', ...over })

describe('form validation', () => {
  it('amounts: rejects rather than rounds', () => {
    expect(toMinorUnits('25.00')).toBe(2500)
    expect(toMinorUnits('25.999')).toBeNull()
    expect(toMinorUnits('0')).toBeNull()
    expect(toMinorUnits('-5')).toBeNull()
    expect(toMinorUnits('500', 0)).toBe(500)
    expect(toMinorUnits('5.5', 0)).toBeNull()
  })
  it('every sender gives an email (G15)', () => {
    expect(validate(form({ buyerEmail: '' }), {}).buyerEmail).toBe("We need your email to tell you when it's claimed.")
    expect(validate(form({ buyerEmail: 'me@example.com' }), {}).buyerEmail).toBeUndefined()
  })
  it('a gift goes only to an email: there is no handle field and an empty email is refused', () => {
    expect(EMPTY_FORM).not.toHaveProperty('handle')
    expect(EMPTY_FORM).not.toHaveProperty('deliver')
    expect(validate(form({ email: '' }), {}).email).toBe('Enter an email address.')
    expect(validate(form({ email: 'bob@imani.casa' }), {})).toEqual({})
  })
  it('a code gift is refused where the shop takes no codes, and fine where it does', () => {
    expect(validate(form({ gift: 'code' }), {}).gift).toMatch(/codes/)
    expect(validate(form({ gift: 'code' }), { codeGifts: true })).toEqual({})
    expect(validate(form({ gift: 'voucher' }), { codeGifts: false })).toEqual({})
  })
  it('email syntax', () => {
    expect(isEmail('bob@example.com')).toBe(true)
    expect(isEmail('bob@exmaple')).toBe(false)
    expect(validate(form({ email: 'nope' }), {}).email).toBeDefined()
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
  const ctx = { stallPubkey: STALL, stallHandle: 'alice@imani.casa', currency: 'eur', terms: 'EUR:90:100', refundPubkey: BOB }
  it('builds the request from the form, normalised', () => {
    const req = draftRequest(form({ email: ' bob@example.com ', message: '  hi  ' }), ctx)
    expect(req).toMatchObject({ amountMinor: 2000, currency: 'EUR', delivery: { kind: 'email', email: 'bob@example.com', refundPubkey: BOB }, message: 'hi', buyerEmail: 'me@example.com' })
    expect(req.delivery).not.toHaveProperty('handle')
  })
  it('every gift carries the seal; a signed-in sender still sends their email (G15)', () => {
    const e = draftRequest(form(), { ...ctx, sealed: 'v1.x.y' })
    expect(e.delivery).toEqual({ kind: 'email', email: 'bob@example.com', refundPubkey: BOB, sealed: 'v1.x.y' })
    expect(draftRequest(form(), { ...ctx }).buyerEmail).toBe('me@example.com')
  })
  it('a voucher request is byte-for-byte the old shape (no gift field); a code says so', () => {
    expect(draftRequest(form(), ctx)).not.toHaveProperty('gift')
    expect(draftRequest(form({ gift: 'code' }), ctx).gift).toBe('code')
  })
  const draft = (over: Partial<Draft['delivery']> = {}, top: Partial<Draft> = {}): Draft => ({
    draftId: 'd1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    stallPubkey: STALL,
    amountMinor: 2000,
    currency: 'EUR',
    delivery: { kind: 'email', email: 'bob@example.com', refundPubkey: BOB, claimWindowDays: 30, ...over },
    ...top,
  })
  it('accepts a draft that pins what was reviewed', () => {
    expect(draftMatches(draft(), draftRequest(form(), ctx))).toBe(true)
    expect(draftMatches(draft({}, { gift: 'code' }), draftRequest(form({ gift: 'code' }), ctx))).toBe(true)
  })
  it('refuses a draft that pinned another recipient, amount, stall, currency, refund key or gift kind', () => {
    const req = draftRequest(form(), ctx)
    expect(draftMatches(draft({ email: 'eve@example.com' }), req)).toBe(false)
    // A server that does not know codes answers a voucher: never paid as a code, and the reverse.
    expect(draftMatches(draft(), draftRequest(form({ gift: 'code' }), ctx))).toBe(false)
    expect(draftMatches(draft({}, { gift: 'code' }), req)).toBe(false)
    expect(draftMatches(draft({}, { amountMinor: 1 }), req)).toBe(false)
    expect(draftMatches(draft({}, { stallPubkey: BOB }), req)).toBe(false)
    expect(draftMatches(draft({}, { currency: 'USD' }), req)).toBe(false)
    expect(draftMatches(draft({ refundPubkey: STALL }), req)).toBe(false)
    expect(draftMatches(draft({ kind: 'handle' }), req)).toBe(false)
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
  it('G11 + G17: half the validity, at most 14 days', () => {
    const t = Date.UTC(2026, 0, 1)
    expect(claimDeadline(t, 90).getTime()).toBe(t + 14 * 86_400_000)
    expect(claimDeadline(t, 90, 30).getTime()).toBe(t + 14 * 86_400_000)
    expect(claimDeadline(t, 20).getTime()).toBe(t + 10 * 86_400_000)
    expect(claimDeadline(t, 10).getTime()).toBe(t + 5 * 86_400_000)
    expect(claimDeadline(t, 0).getTime()).toBe(t + 14 * 86_400_000)
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
  it('a form kept by the old page (a handle gift) comes back as an email gift, asking for the email', () => {
    const store = new Map([['imani:gift:alice', JSON.stringify({ form: { amount: '20', deliver: 'handle', handle: 'bob@example.com', email: '', message: 'hi', from: '', buyerEmail: 'me@example.com' }, draftId: 'old' })]])
    const kept = recall('alice', { getItem: (k: string) => store.get(k) ?? null })!
    expect(kept.form).toEqual({ amount: '20', gift: 'voucher', email: '', message: 'hi', from: '', buyerEmail: 'me@example.com' })
    expect(kept.draftId).toBe('old')
    expect(validate(kept.form, {}).email).toBeDefined()
  })
})

describe('gift secrets (G3, G4, G8)', () => {
  it('every buyer (the site is public): a fresh R whose pubkey is the refund key, and a link secret', () => {
    const g = newGiftSecrets()
    expect(getPublicKey(hexToBytes(g.refundSecret)).toString()).toBe(g.refundPubkey)
    expect(g.linkSecret).toMatch(/^[0-9a-f]{64}$/)
  })
  it('R is never reused: two gifts get two refund keys', () => {
    expect(newGiftSecrets().refundPubkey).not.toBe(newGiftSecrets().refundPubkey)
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
    const req = draftRequest(form(), { stallPubkey: STALL, stallHandle: 'alice@imani.casa', currency: 'EUR', terms: 't', refundPubkey: BOB })
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
