/**
 * @vitest-environment node
 *
 * subscription.imani.casa end to end at the service boundary: a real NAP login from a stall key
 * (merchant-only, #411), real Stripe webhook signatures, a real ledger on disk, and the licence it
 * mints read back through the wallet's OWN reader and verifier. Only the gateway and Stripe's API
 * are faked, by URL.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { beforeEach, describe, expect, it } from 'vitest'
import { acceptCatalog, BUNDLED_CATALOG, entitlementOf, FREE_TIER_AMOUNTS, licenceOf, parseCatalog } from '@imani/licence'
import { buildAuthCompleteRequest, createPrivateKeySigner } from '@imani/nap-client-http'

import { createApp, type Request } from '../app.ts'
import { SESSION_COOKIE } from '../auth.ts'
import type { SubscriptionConfig } from '../config.ts'
import { LicenceIssuer, sellerFrom } from '../issuer.ts'
import { Ledger } from '../ledger.ts'
import { type MerchantStanding } from '../merchantRole.ts'
import { stripeSignatureHeader, type StripeClient } from '../stripe.ts'
import { relayStatusNotifier } from '../statusNotifier.ts'
import { relayBadgePublisher } from '../badgePublisher.ts'
import { badgeAt, parseVerification, verificationD } from '../../../src/lib/verificationBadge.ts'
import { catalogSignedBy as catalogSignatureValid } from '../../../src/lib/catalogSignature.ts'
import { unwrapSealed } from '../../../src/lib/giftWrap.ts'
import { parseSubscriptionStatus } from '../../../src/lib/subscriptionStatus.ts'
import type { Event } from 'nostr-tools'

const ORIGIN = 'https://subscription.test'
const WALLET = 'http://gateway:8082'
const WEBHOOK_SECRET = 'whsec_test'
const SELLER_SK = generateSecretKey()
const SELLER = sellerFrom(nip19.nsecEncode(SELLER_SK))
const STALL_SK = generateSecretKey()
const STALL = getPublicKey(STALL_SK)
const ADMIN_SK = generateSecretKey()
const ADMIN = getPublicKey(ADMIN_SK)
const CUSTOMER_SK = generateSecretKey()
const CATALOG = (await readFile(join(__dirname, '..', 'catalog.json'), 'utf8')).trim()

/** Who has a live, signed stall record, as the fake gateway's nostr query answers it. */
let merchants = new Set<string>()
/** Standing the fake gateway reports for a key, or `unknown` when it is "down". */
let gatewayDown = false
const standing = async (pk: string): Promise<MerchantStanding> => (gatewayDown ? 'unknown' : merchants.has(pk) ? 'merchant' : 'customer')

/** Session cookies by key, from a real NAP login against the app. */
let cookies = new Map<Uint8Array, string>()

async function login(sk: Uint8Array): Promise<{ status: number; cookie?: string; body: unknown }> {
  const npub = nip19.npubEncode(getPublicKey(sk))
  const init = await app.handle({ method: 'POST', path: '/v1/auth/init', headers: {}, body: JSON.stringify({ npub }) })
  if (init.status !== 200) return { status: init.status, body: init.body }
  const completion = await buildAuthCompleteRequest({
    challenge: init.body as Parameters<typeof buildAuthCompleteRequest>[0]['challenge'],
    signer: createPrivateKeySigner(Buffer.from(sk).toString('hex')),
  })
  const out = await app.handle({
    method: 'POST',
    path: '/v1/auth/complete',
    headers: { authorization: completion.authorization },
    body: new TextDecoder().decode(completion.rawBody),
  })
  const set = out.headers?.['Set-Cookie']
  const cookie = set?.split(';')[0]
  return { status: out.status, cookie, body: out.body }
}

async function cookieFor(sk: Uint8Array): Promise<string> {
  const held = cookies.get(sk)
  if (held) return held
  const out = await login(sk)
  if (!out.cookie) throw new Error(`login failed: ${out.status} ${JSON.stringify(out.body)}`)
  cookies.set(sk, out.cookie)
  return out.cookie
}

/** A request with the session cookie of `sk`'s login, or with no session at all. */
const req = async (sk: Uint8Array | null, method: string, path: string, payload?: unknown): Promise<Request> => {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  return { method, path, body, headers: sk ? { cookie: await cookieFor(sk) } : {} }
}

/** A fake gateway-customer: mints a voucher whose token is the metadata it was given. */
function fakeGateway() {
  const minted: Array<{ body: Record<string, unknown>; idem: string | null }> = []
  const delivered: Array<Record<string, unknown>> = []
  let failDelivery = false
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (u === `${WALLET}/api/v1/wallet/vouchers`) {
      const idem = headers['Idempotency-Key'] ?? null
      const prior = minted.find((m) => m.idem === idem)
      if (!prior) minted.push({ body, idem })
      const index = prior ? minted.indexOf(prior) : minted.length - 1
      const meta = (prior ?? minted[index]).body.merchant_metadata
      return new Response(
        JSON.stringify({ voucher_id: `v${index}`, status: 'ISSUED', token: JSON.stringify(meta), memo: body.memo, face_value: body.face_value }),
        { status: 201 },
      )
    }
    if (u === `${WALLET}/api/v1/dm/tokens/send`) {
      if (failDelivery) return new Response('relay down', { status: 503 })
      delivered.push(body)
      return new Response(JSON.stringify({ event_id: 'e' }), { status: 200 })
    }
    if (u === `${WALLET}/api/v1/wallet/licences/revoke`) return new Response('{}', { status: 200 })
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, minted, delivered, setFailDelivery: (v: boolean) => (failDelivery = v) }
}

const fakeStripe = (): StripeClient & { checkouts: unknown[]; priceReads: string[]; prices: Map<string, { unitAmount: number; currency: string }> } => {
  const checkouts: unknown[] = []
  const priceReads: string[] = []
  // The published plan (www.imani.casa/pricing), in GBP: Essentials (`basic`) £8/month, Pro £250/year.
  const prices = new Map([
    ['price_b_m', { unitAmount: 800, currency: 'GBP' }],
    ['price_p_a', { unitAmount: 25000, currency: 'GBP' }],
  ])
  return {
    checkouts,
    priceReads,
    prices,
    async getPrice(id) {
      priceReads.push(id)
      const p = prices.get(id)
      if (!p) throw new Error(`stripe /prices/${id} 404: No such price`)
      return p
    },
    async createCheckout(i) {
      checkouts.push(i)
      return { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }
    },
    async createPortal() {
      return { url: 'https://billing.stripe.test/p' }
    },
  }
}

let gateway: ReturnType<typeof fakeGateway>
let stripe: ReturnType<typeof fakeStripe>
let app: ReturnType<typeof createApp>
let ledger: Ledger
let logs: Array<Record<string, unknown>>
/** Wraps the service published, as the relay would receive them. */
let published: Event[]
/** Wraps handed to the gateway's index. */
let stored: Event[]
/** Verification-badge attestations the service published (#418). */
let badgeEvents: Event[] = []
/** The badge a viewer would see for STALL at `at`, from the newest attestation published. */
function publicBadge(at: number) {
  const newest = badgeEvents.filter((e) => e.tags.some(([n, v]) => n === 'd' && v === verificationD(STALL))).at(-1)
  if (!newest) return undefined
  return badgeAt(parseVerification(newest.content, STALL) ?? [], at)
}
let relayDown = false
let indexDown = false

function makeApp(over: { catalogBody?: string; prices?: Record<string, string> } = {}) {
  const config: SubscriptionConfig = {
    publicOrigin: ORIGIN,
    basePath: '',
    walletUrl: WALLET,
    edgeSecret: 'edge',
    internalRelay: 'ws://relay',
    sellerNsec: '',
    stripeSecretKey: 'sk',
    stripeWebhookSecret: WEBHOOK_SECRET,
    prices: over.prices ?? { 'basic:monthly': 'price_b_m', 'pro:annual': 'price_p_a' },
    adminPubkeys: [ADMIN],
    ledgerPath: '',
    catalogPath: '',
    port: 0,
    automaticTax: true,
  }
  return createApp({
    config,
    ledger,
    seller: SELLER,
    stripe,
    catalogBody: over.catalogBody ?? CATALOG,
    issuer: new LicenceIssuer({ walletUrl: WALLET, edgeSecret: 'edge', internalRelay: 'ws://relay', seller: SELLER, fetch: gateway.fetchImpl, sleep: async () => {} }),
    merchantStanding: standing,
    notifier: relayStatusNotifier({
      seller: SELLER,
      relayUrl: 'ws://relay',
      publish: async (_url, event) => {
        if (relayDown) throw new Error('relay down')
        published.push(event)
      },
      store: async (event) => {
        if (indexDown) throw new Error('index down')
        stored.push(event)
      },
    }),
    napServerOptions: { minAuthResponseMillis: 0 },
    badges: relayBadgePublisher({
      seller: SELLER,
      catalog: parseCatalog(over.catalogBody ?? CATALOG)!,
      relayUrl: 'ws://relay',
      publish: async (_url, event) => {
        if (relayDown) throw new Error('relay down')
        badgeEvents.push(event)
      },
    }),
    log: (e) => logs.push(e),
  })
}

beforeEach(async () => {
  gateway = fakeGateway()
  stripe = fakeStripe()
  logs = []
  published = []
  stored = []
  badgeEvents = []
  relayDown = false
  indexDown = false
  ledger = new Ledger(join(await mkdtemp(join(tmpdir(), 'sub-')), 'ledger.json'))
  app = makeApp()
  merchants = new Set([STALL, ADMIN])
  gatewayDown = false
  cookies = new Map()
})

/** Read a delivered "token" (the fake gateway's: the signed metadata) as the wallet would. */
function licenceFromDelivery(d: Record<string, unknown>, expiresAt: number) {
  return licenceOf({
    issuerPublicKey: 'g',
    issuerSignature: 's',
    merchantMetadata: String(d.token),
    expiresAt,
    faceValue: 1,
    unit: 'GBP',
    lockKey: STALL,
    issuerId: SELLER.pk,
  } as never)
}

function invoicePaid(id: string, start: number, end: number, tier = 'basic', term = 'monthly') {
  const body = JSON.stringify({
    type: 'invoice.paid',
    data: {
      object: {
        id,
        subscription: 'sub_stripe_1',
        customer: 'cus_1',
        amount_paid: 1500,
        currency: 'gbp',
        subscription_details: { metadata: { stall_pubkey: STALL, tier, term } },
        lines: { data: [{ period: { start, end } }] },
      },
    },
  })
  return { method: 'POST', path: '/v1/stripe/webhook', body, headers: { 'stripe-signature': stripeSignatureHeader(body, WEBHOOK_SECRET) } }
}

describe('signing in: a NAP session, merchants only (#411)', () => {
  it('refuses every account route without a session', async () => {
    for (const [method, path] of [
      ['GET', '/v1/me'],
      ['POST', '/v1/checkout'],
      ['POST', '/v1/portal'],
      ['POST', '/v1/licences/resend'],
      ['POST', '/v1/admin/grants'],
      ['POST', '/v1/admin/revoke'],
    ] as const) {
      expect((await app.handle(await req(null, method, path))).status, `${method} ${path}`).toBe(401)
    }
  })

  it('the public routes stay public', async () => {
    expect((await app.handle({ method: 'GET', path: '/v1/plans', headers: {}, body: '' })).status).toBe(200)
    expect((await app.handle({ method: 'GET', path: '/v1/catalog', headers: {}, body: '' })).status).toBe(200)
  })

  it('a merchant logs in with a NAP proof and gets an HttpOnly session cookie scoped to the site', async () => {
    const out = await login(STALL_SK)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ status: 'ok', principal: { pubkey: STALL }, roles: ['merchant'] })
    // Cookie mode: the access token never reaches script.
    expect(JSON.stringify(out.body)).not.toContain('access_token')
    const me = await app.handle({ method: 'GET', path: '/v1/me', headers: { cookie: out.cookie }, body: '' })
    expect(me).toMatchObject({ status: 200, body: { pubkey: STALL, roles: ['merchant'], admin: false, subscriptions: [] } })
  })

  it('the cookie is HttpOnly, SameSite=Lax, Secure on https, and scoped to the mount path', async () => {
    const npub = nip19.npubEncode(STALL)
    const init = await app.handle({ method: 'POST', path: '/v1/auth/init', headers: {}, body: JSON.stringify({ npub }) })
    const completion = await buildAuthCompleteRequest({
      challenge: init.body as Parameters<typeof buildAuthCompleteRequest>[0]['challenge'],
      signer: createPrivateKeySigner(Buffer.from(STALL_SK).toString('hex')),
    })
    const out = await app.handle({ method: 'POST', path: '/v1/auth/complete', headers: { authorization: completion.authorization }, body: new TextDecoder().decode(completion.rawBody) })
    const set = out.headers?.['Set-Cookie'] ?? ''
    expect(set.startsWith(`${SESSION_COOKIE}=`)).toBe(true)
    expect(set).toContain('HttpOnly')
    expect(set).toContain('SameSite=Lax')
    expect(set).toContain('Secure')
    expect(set).toContain('Path=/')
  })

  it('a customer (no stall record) is refused AT LOGIN, with a sentence, and never holds a session', async () => {
    const out = await login(CUSTOMER_SK)
    expect(out.status).toBe(403)
    expect(out.cookie).toBeUndefined()
    expect(out.body).toMatchObject({ error: expect.stringMatching(/for stalls/i) })
  })

  it('the gateway being unreachable refuses login (fail closed), without claiming the key is a customer', async () => {
    gatewayDown = true
    const out = await login(STALL_SK)
    expect(out.status).toBe(403)
    expect(out.cookie).toBeUndefined()
  })

  it('a stall that retires its record loses access on its next request, not when the session ends', async () => {
    const cookie = await cookieFor(STALL_SK)
    expect((await app.handle({ method: 'GET', path: '/v1/me', headers: { cookie }, body: '' })).status).toBe(200)
    merchants.delete(STALL)
    expect((await app.handle({ method: 'GET', path: '/v1/me', headers: { cookie }, body: '' })).status).toBe(403)
    // A definite "not a merchant" revokes the session: restoring the record does not bring it back.
    merchants.add(STALL)
    expect((await app.handle({ method: 'GET', path: '/v1/me', headers: { cookie }, body: '' })).status).toBe(401)
  })

  it('a gateway outage refuses the request but keeps the session', async () => {
    const cookie = await cookieFor(STALL_SK)
    gatewayDown = true
    expect((await app.handle({ method: 'GET', path: '/v1/me', headers: { cookie }, body: '' })).status).toBe(403)
    gatewayDown = false
    expect((await app.handle({ method: 'GET', path: '/v1/me', headers: { cookie }, body: '' })).status).toBe(200)
  })

  it('the session view answers for a live session, and logout ends it', async () => {
    const cookie = await cookieFor(STALL_SK)
    const view = await app.handle({ method: 'GET', path: '/v1/auth/session', headers: { cookie }, body: '' })
    expect(view).toMatchObject({ status: 200, body: { principal: { pubkey: STALL }, roles: ['merchant'] } })
    const out = await app.handle({ method: 'POST', path: '/v1/auth/logout', headers: { cookie }, body: '' })
    expect(out.status).toBe(200)
    expect(out.headers?.['Set-Cookie']).toContain('Max-Age=0')
    expect((await app.handle({ method: 'GET', path: '/v1/auth/session', headers: { cookie }, body: '' })).status).toBe(401)
    expect((await app.handle({ method: 'GET', path: '/v1/me', headers: { cookie }, body: '' })).status).toBe(401)
  })

  it('a forged or unknown cookie is no session', async () => {
    const out = await app.handle({ method: 'GET', path: '/v1/me', headers: { cookie: `${SESSION_COOKIE}=forged` }, body: '' })
    expect(out.status).toBe(401)
  })

  it('a NAP proof addressed to another site is refused (audience binding)', async () => {
    const npub = nip19.npubEncode(STALL)
    const init = await app.handle({ method: 'POST', path: '/v1/auth/init', headers: {}, body: JSON.stringify({ npub }) })
    const challenge = init.body as Parameters<typeof buildAuthCompleteRequest>[0]['challenge']
    const completion = await buildAuthCompleteRequest({
      challenge: { ...challenge, auth_url: 'https://gifting.test/v1/auth/complete' },
      signer: createPrivateKeySigner(Buffer.from(STALL_SK).toString('hex')),
    })
    const out = await app.handle({ method: 'POST', path: '/v1/auth/complete', headers: { authorization: completion.authorization }, body: new TextDecoder().decode(completion.rawBody) })
    expect(out.status).toBe(401)
    expect(out.headers?.['Set-Cookie']).toBeUndefined()
  })
})

describe('buying a plan', () => {
  it('opens Stripe Checkout for the stall, card only, with tax and the stall key in metadata', async () => {
    const out = await app.handle(await req(STALL_SK, 'POST', '/v1/checkout', { tier: 'basic', term: 'monthly' }))
    expect(out).toMatchObject({ status: 200, body: { url: 'https://checkout.stripe.test/cs_1' } })
    expect(stripe.checkouts[0]).toMatchObject({ priceId: 'price_b_m', stallPubkey: STALL, tier: 'basic', term: 'monthly', automaticTax: true })
  })

  it('refuses a tier or term with no price', async () => {
    expect((await app.handle(await req(STALL_SK, 'POST', '/v1/checkout', { tier: 'pro', term: 'monthly' }))).status).toBe(400)
  })

  it('mints a Basic licence for the paid period on invoice.paid, locked to the stall, and delivers it', async () => {
    const start = 1_800_000_000
    const end = start + 30 * 86_400
    const out = await app.handle(invoicePaid('in_1', start, end))
    expect(out.status).toBe(200)
    expect(gateway.minted).toHaveLength(1)
    expect(gateway.minted[0].body).toMatchObject({ backing_strategy: 'FIXED', face_value: 1500, face_unit: 'GBP', issuer_id: SELLER.pk })
    expect(gateway.delivered[0]).toMatchObject({ recipient_pubkey: STALL, expires_at: end })

    const licence = licenceFromDelivery(gateway.delivered[0], end)!
    expect(licence).toMatchObject({ tier: 'basic', validFrom: start, grantKind: 'subscription', features: ['terminals'], lockKey: STALL })
    const ent = entitlementOf({
      catalog: BUNDLED_CATALOG,
      grants: [{ features: licence.features!, expiresAt: end, pilot: false, tier: licence.tier, validFrom: licence.validFrom }],
      currency: 'GBP',
      now: start + 1,
    })
    expect(ent).toMatchObject({ tier: 'basic', terminals: 3, sales: null })
  })

  it('mints nothing twice when Stripe replays the event', async () => {
    const ev = invoicePaid('in_1', 1_800_000_000, 1_802_000_000)
    await app.handle(ev)
    const again = await app.handle({ ...ev, headers: { 'stripe-signature': stripeSignatureHeader(ev.body, WEBHOOK_SECRET) } })
    expect(again).toMatchObject({ status: 200, body: { duplicate: true } })
    expect(gateway.minted).toHaveLength(1)
    expect(gateway.delivered).toHaveLength(1)
  })

  it('a renewal is a new licence under the SAME subscription id, starting when the period does', async () => {
    await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_592_000))
    await app.handle(invoicePaid('in_2', 1_802_592_000, 1_805_184_000))
    const rows = await ledger.all()
    expect(rows).toHaveLength(1)
    expect(rows[0].licences.map((l) => l.validFrom)).toEqual([1_800_000_000, 1_802_592_000])
    const ids = gateway.delivered.map((d) => (licenceFromDelivery(d, 1_900_000_000)!).subscriptionId)
    expect(new Set(ids).size).toBe(1)
  })

  it('a failed delivery is retried without minting again, and returns 500 so Stripe retries too', async () => {
    gateway.setFailDelivery(true)
    const ev = invoicePaid('in_1', 1_800_000_000, 1_802_000_000)
    expect((await app.handle(ev)).status).toBe(500)
    gateway.setFailDelivery(false)
    const retry = await app.handle({ ...ev, headers: { 'stripe-signature': stripeSignatureHeader(ev.body, WEBHOOK_SECRET) } })
    expect(retry.status).toBe(200)
    expect(gateway.minted).toHaveLength(1)
    expect(gateway.delivered).toHaveLength(1)
  })

  it('reads the subscription from `parent.subscription_details` (Stripe API 2025-03-31+)', async () => {
    const body = JSON.stringify({
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_basil',
          customer: 'cus_1',
          amount_paid: 1500,
          currency: 'gbp',
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_basil', metadata: { stall_pubkey: STALL, tier: 'pro', term: 'annual' } } },
          lines: { data: [{ period: { start: 1_800_000_000, end: 1_831_536_000 } }] },
        },
      },
    })
    const out = await app.handle({ method: 'POST', path: '/v1/stripe/webhook', body, headers: { 'stripe-signature': stripeSignatureHeader(body, WEBHOOK_SECRET) } })
    expect(out.status).toBe(200)
    expect((await ledger.all())[0]).toMatchObject({ stripeSubscriptionId: 'sub_basil', tier: 'pro' })
    expect(licenceFromDelivery(gateway.delivered[0], 1_831_536_000)).toMatchObject({ tier: 'pro', features: ['terminals', 'api', 'ecommerce'] })
  })

  it('refuses a webhook without a valid Stripe signature', async () => {
    const ev = invoicePaid('in_1', 1, 2)
    expect((await app.handle({ ...ev, headers: { 'stripe-signature': stripeSignatureHeader(ev.body, 'whsec_wrong') } })).status).toBe(400)
    expect(gateway.minted).toHaveLength(0)
  })

  it('ignores (200) an invoice that is not ours, so Stripe does not retry it forever', async () => {
    const body = JSON.stringify({ type: 'invoice.paid', data: { object: { id: 'in_x', lines: { data: [] } } } })
    const out = await app.handle({ method: 'POST', path: '/v1/stripe/webhook', body, headers: { 'stripe-signature': stripeSignatureHeader(body, WEBHOOK_SECRET) } })
    expect(out.status).toBe(200)
    expect(gateway.minted).toHaveLength(0)
  })

  it('cancelling marks the row and revokes nothing', async () => {
    await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_000_000))
    const body = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { id: 'sub_stripe_1', status: 'active', cancel_at_period_end: true } } })
    await app.handle({ method: 'POST', path: '/v1/stripe/webhook', body, headers: { 'stripe-signature': stripeSignatureHeader(body, WEBHOOK_SECRET) } })
    expect((await ledger.all())[0].status).toBe('cancelled')
  })

  describe('every way Stripe says a subscription is cancelled', () => {
    const event = (type: string, object: Record<string, unknown>) => {
      const body = JSON.stringify({ type, data: { object: { id: 'sub_stripe_1', ...object } } })
      return { method: 'POST', path: '/v1/stripe/webhook', body, headers: { 'stripe-signature': stripeSignatureHeader(body, WEBHOOK_SECRET) } }
    }
    const status = async () => (await ledger.all())[0].status

    it('the portal on API 2025-03-31+ sets cancel_at and leaves cancel_at_period_end false (sub_738c90f3fbfe6e46)', async () => {
      await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_000_000))
      // As Stripe sent it for the local cancellation on 2026-10-29 (api_version 2026-02-25.clover).
      const out = await app.handle(event('customer.subscription.updated', { status: 'active', cancel_at_period_end: false, cancel_at: 1_802_000_000, canceled_at: 1_800_100_000 }))
      expect(out.status).toBe(200)
      expect(await status()).toBe('cancelled')
      expect(gateway.minted).toHaveLength(1)
    })

    it('customer.subscription.deleted: the subscription has ended', async () => {
      await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_000_000))
      await app.handle(event('customer.subscription.deleted', { status: 'canceled', ended_at: 1_802_000_000 }))
      expect(await status()).toBe('cancelled')
    })

    it('undoing the cancellation before the period ends makes it active again', async () => {
      await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_000_000))
      await app.handle(event('customer.subscription.updated', { status: 'active', cancel_at_period_end: false, cancel_at: 1_802_000_000 }))
      expect(await status()).toBe('cancelled')
      await app.handle(event('customer.subscription.updated', { status: 'active', cancel_at_period_end: false, cancel_at: null, canceled_at: null }))
      expect(await status()).toBe('active')
    })

    it('a revoked subscription stays revoked whatever Stripe says next', async () => {
      await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_000_000))
      await ledger.update((rows) => {
        rows[0].status = 'revoked'
      })
      await app.handle(event('customer.subscription.updated', { status: 'active', cancel_at: null }))
      expect(await status()).toBe('revoked')
      expect(published).toHaveLength(0)
    })
  })

  describe('the webhook tells the stall’s wallet (a seller-sealed DM)', () => {
    const event = (type: string, object: Record<string, unknown>) => {
      const body = JSON.stringify({ type, data: { object: { id: 'sub_stripe_1', ...object } } })
      return { method: 'POST', path: '/v1/stripe/webhook', body, headers: { 'stripe-signature': stripeSignatureHeader(body, WEBHOOK_SECRET) } }
    }
    const opened = (i: number) => unwrapSealed(published[i], STALL_SK)

    it('a cancellation is sent to the stall, sealed by the seller, with the date it ends', async () => {
      await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_000_000))
      const row = (await ledger.all())[0]
      await app.handle(event('customer.subscription.updated', { status: 'active', cancel_at_period_end: false, cancel_at: 1_802_000_000 }))
      expect(published).toHaveLength(1)
      expect(published[0].tags).toContainEqual(['p', STALL])
      const o = opened(0)
      expect(o?.sealer).toBe(SELLER.pk)
      expect(parseSubscriptionStatus(o!.rumor.content)).toMatchObject({ subscriptionId: row.subscriptionId, status: 'cancelled', endsAt: 1_802_000_000 })
      // Only the stall can open it.
      expect(unwrapSealed(published[0], CUSTOMER_SK)).toBeNull()
    })

    it('Stripe’s several events for one cancellation send ONE message', async () => {
      await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_000_000))
      const cancel = { status: 'active', cancel_at: 1_802_000_000 }
      await app.handle(event('customer.subscription.updated', cancel))
      await app.handle(event('customer.subscription.updated', { ...cancel, cancellation_details: { feedback: 'unused' } }))
      expect(published).toHaveLength(1)
    })

    it('undoing it sends "active", and the wallet can tell which came last', async () => {
      await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_000_000))
      await app.handle(event('customer.subscription.updated', { status: 'active', cancel_at: 1_802_000_000 }))
      await app.handle(event('customer.subscription.updated', { status: 'active', cancel_at: null }))
      expect(published).toHaveLength(2)
      const [a, b] = [0, 1].map((i) => parseSubscriptionStatus(opened(i)!.rumor.content)!)
      expect([a.status, b.status]).toEqual(['cancelled', 'active'])
      expect(b.at).toBeGreaterThanOrEqual(a.at)
    })

    it('is never backdated, so the wallet poll (watermark - 60 s) fetches an undo sent after a cancel', async () => {
      // NIP-59 backdates wraps by up to 10 minutes; the undo of a cancellation was then never
      // fetched on the local deployment. Status wraps carry the real time.
      await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_000_000))
      for (let i = 0; i < 6; i++) {
        await app.handle(event('customer.subscription.updated', { status: 'active', cancel_at: i % 2 === 0 ? 1_802_000_000 : null }))
      }
      const nowSec = Math.floor(Date.now() / 1000)
      expect(published).toHaveLength(6)
      for (const w of published) expect(nowSec - w.created_at).toBeLessThan(60)
    })

    it('nothing is sent when nothing changed, and a relay that is down never fails the webhook', async () => {
      await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_000_000))
      await app.handle(event('customer.subscription.updated', { status: 'active' }))
      expect(published).toHaveLength(0)
      relayDown = true
      indexDown = true
      const out = await app.handle(event('customer.subscription.updated', { status: 'active', cancel_at: 1_802_000_000 }))
      expect(out.status).toBe(200)
      expect((await ledger.all())[0].status).toBe('cancelled')
      expect(logs).toContainEqual(expect.objectContaining({ event: 'subscription_status_failed' }))
    })

    it('the same wrap goes to the relay AND the gateway index the wallet polls; either one is enough', async () => {
      await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_000_000))
      await app.handle(event('customer.subscription.updated', { status: 'active', cancel_at: 1_802_000_000 }))
      expect(stored.map((e) => e.id)).toEqual(published.map((e) => e.id))
      relayDown = true
      await app.handle(event('customer.subscription.updated', { status: 'active', cancel_at: null }))
      expect(stored).toHaveLength(2)
      expect(logs).toContainEqual(expect.objectContaining({ event: 'subscription_status_sent', status: 'active' }))
    })
  })

  it('shows the stall its own subscription and lets it re-send a lost licence', async () => {
    const end = Math.floor(Date.now() / 1000) + 10 * 86_400
    await app.handle(invoicePaid('in_1', end - 30 * 86_400, end))
    const me = await app.handle(await req(STALL_SK, 'GET', '/v1/me'))
    expect(me.body).toMatchObject({ subscriptions: [{ tier: 'basic', kind: 'subscription', has_card: true, licences: [{ state: 'delivered' }] }] })
    expect(JSON.stringify(me.body)).not.toContain('cus_1')
    const resent = await app.handle(await req(STALL_SK, 'POST', '/v1/licences/resend'))
    expect(resent).toMatchObject({ status: 200, body: { sent: 1 } })
    expect(gateway.minted).toHaveLength(1)
    expect(gateway.delivered).toHaveLength(2)
  })
})

describe('hand grants (#407 §7)', () => {
  const grantBody = { stall_pubkey: STALL, limits: { sales: { amounts: { GBP: 20000 } } }, days: 30, reason: 'free tier used up, pilot' }

  it('only an admin may issue one', async () => {
    expect((await app.handle(await req(STALL_SK, 'POST', '/v1/admin/grants', grantBody))).status).toBe(403)
    expect(gateway.minted).toHaveLength(0)
  })

  it('raises a free stall to 200 for 30 days from now, recorded with who and why', async () => {
    const out = await app.handle(await req(ADMIN_SK, 'POST', '/v1/admin/grants', grantBody))
    expect(out.status).toBe(201)
    const row = (await ledger.all())[0]
    expect(row).toMatchObject({ grantKind: 'custom', issuedBy: ADMIN, reason: 'free tier used up, pilot', stallPubkey: STALL })
    const l = licenceFromDelivery(gateway.delivered[0], row.licences[0].validTo)!
    expect(l).toMatchObject({ tier: 'custom', grantKind: 'custom', features: [], limits: { sales: { period: 'window', amounts: { GBP: 20000 } } } })
    expect(row.licences[0].validTo - row.licences[0].validFrom).toBe(30 * 86_400)
    expect(gateway.minted[0].body.face_value).toBe(1)
  })

  it('refuses a grant with no reason, or a garbled limit, or nothing to lift', async () => {
    for (const bad of [
      { ...grantBody, reason: '' },
      { ...grantBody, limits: { sales: { amounts: { GBP: 'lots' } } } },
      { stall_pubkey: STALL, reason: 'x' },
      { ...grantBody, stall_pubkey: 'nope' },
    ]) {
      expect((await app.handle(await req(ADMIN_SK, 'POST', '/v1/admin/grants', bad))).status).toBe(400)
    }
    expect(gateway.minted).toHaveLength(0)
  })
})

describe('the verification badge (#418)', () => {
  const grantBody = { stall_pubkey: STALL, limits: { terminals: 5 }, days: 30, reason: 'partner pilot' }

  it('a paid Essentials invoice publishes a bronze badge for exactly the paid window, signed by the seller', async () => {
    const [start, end] = [1_800_000_000, 1_802_592_000]
    await app.handle(invoicePaid('in_1', start, end, 'basic'))
    const e = badgeEvents.at(-1)!
    expect(e.pubkey).toBe(SELLER.pk)
    expect(e.tags).toContainEqual(['d', verificationD(STALL)])
    expect(publicBadge(start)).toBe('bronze')
    expect(publicBadge(end - 1)).toBe('bronze')
    // No grace: the badge is off the moment the paid window ends.
    expect(publicBadge(end)).toBeNull()
    // Nothing about money in public.
    expect(e.content).not.toMatch(/paid|price|stripe|sub_/i)
  })

  it('Pro is silver; held with Essentials the highest wins', async () => {
    await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_592_000, 'pro', 'annual'))
    expect(publicBadge(1_800_000_001)).toBe('silver')
  })

  it('an early renewal extends it seamlessly', async () => {
    await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_592_000))
    await app.handle(invoicePaid('in_2', 1_802_592_000, 1_805_184_000))
    expect(publicBadge(1_802_592_000)).toBe('bronze')
    expect(publicBadge(1_805_184_000)).toBeNull()
  })

  it('a revoked (refunded) plan loses its badge at once', async () => {
    await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_592_000))
    const id = (await ledger.all())[0].subscriptionId
    expect(publicBadge(1_800_000_001)).toBe('bronze')
    await app.handle(await req(ADMIN_SK, 'POST', '/v1/admin/revoke', { subscription_id: id, reason: 'refund' }))
    expect(publicBadge(1_800_000_001)).toBeNull()
  })

  it('a hand grant earns the badge it names, gold included, and signs it into the licence', async () => {
    const out = await app.handle(await req(ADMIN_SK, 'POST', '/v1/admin/grants', { ...grantBody, badge: 'gold' }))
    expect(out.status).toBe(201)
    const row = (await ledger.all())[0]
    expect(row.badge).toBe('gold')
    expect(publicBadge(row.licences[0].validFrom)).toBe('gold')
    expect(licenceFromDelivery(gateway.delivered[0], row.licences[0].validTo)?.badge).toBe('gold')
  })

  it('a hand grant that names no badge earns none', async () => {
    await app.handle(await req(ADMIN_SK, 'POST', '/v1/admin/grants', grantBody))
    const row = (await ledger.all())[0]
    expect(publicBadge(row.licences[0].validFrom)).toBeNull()
  })

  it('refuses a badge that does not exist', async () => {
    const out = await app.handle(await req(ADMIN_SK, 'POST', '/v1/admin/grants', { ...grantBody, badge: 'platinum' }))
    expect(out.status).toBe(400)
    expect(gateway.minted).toHaveLength(0)
  })

  it('a relay that is down never fails the payment, and a resend republishes', async () => {
    relayDown = true
    const out = await app.handle(invoicePaid('in_1', 1_800_000_000, 1_802_592_000))
    expect(out.status).toBe(200)
    expect(badgeEvents).toHaveLength(0)
    relayDown = false
    await app.handle(await req(STALL_SK, 'POST', '/v1/licences/resend'))
    expect(publicBadge(1_800_000_001)).toBe('bronze')
  })
})

describe('the plans offered (www.imani.casa/pricing)', () => {
  type ListedPlan = { tier: string; terms: string[]; limits: Record<string, unknown>; prices: Record<string, { amount: number; currency: string }> }
  const listPlans = async (a = app) => (await a.handle({ method: 'GET', path: '/v1/plans', headers: {}, body: '' })).body as ListedPlan[]

  it('are Starter (free), Basic and Pro, with Basic issuing without limit on 3 tills', async () => {
    const plans = await listPlans()
    expect(plans.map((p) => p.tier)).toEqual(['free', 'basic', 'pro'])
    expect(plans[0]).toMatchObject({ terms: [], prices: {}, limits: { terminals: 1, sales: { period: 'lifetime', amounts: { GBP: 10000 } } } })
    expect(plans[1].limits).toEqual({ sales: null, terminals: 3 })
    expect(plans[2].limits).toEqual({ sales: null, terminals: null })
  })

  it('show the amount Stripe will charge, in GBP', async () => {
    const [, basic, pro] = await listPlans()
    expect(basic).toMatchObject({ terms: ['monthly'], prices: { monthly: { amount: 800, currency: 'GBP' } } })
    expect(pro).toMatchObject({ terms: ['annual'], prices: { annual: { amount: 25000, currency: 'GBP' } } })
  })

  it('read each Stripe price once, not on every page view', async () => {
    await listPlans()
    await listPlans()
    expect(stripe.priceReads.sort()).toEqual(['price_b_m', 'price_p_a'])
  })

  it('never offer a tier with no card price: a Town / BID partnership in the catalog stays off the list', async () => {
    const withPartner = JSON.parse(CATALOG) as { version: number; tiers: Record<string, unknown> }
    withPartner.version += 1
    withPartner.tiers.partner = { features: ['terminals', 'api', 'ecommerce'], limits: { sales: null, terminals: null } }
    app = makeApp({ catalogBody: JSON.stringify(withPartner) })
    expect((await listPlans()).map((p) => p.tier)).toEqual(['free', 'basic', 'pro'])
    const out = await app.handle(await req(STALL_SK, 'POST', '/v1/checkout', { tier: 'partner', term: 'annual' }))
    expect(out.status).toBe(400)
    expect(stripe.checkouts).toHaveLength(0)
  })

  it('refuse at boot a price for a tier the catalog does not sell, or for Starter', () => {
    expect(() => makeApp({ prices: { 'partner:annual': 'price_x' } })).toThrow(/partner/)
    expect(() => makeApp({ prices: { 'free:monthly': 'price_x' } })).toThrow(/free/)
  })

  it('never list or sell a price that is not in GBP', async () => {
    stripe.prices.set('price_b_m', { unitAmount: 900, currency: 'EUR' })
    const [, basic] = await listPlans()
    expect(basic.prices).toEqual({})
    const out = await app.handle(await req(STALL_SK, 'POST', '/v1/checkout', { tier: 'basic', term: 'monthly' }))
    expect(out.status).toBe(502)
    expect(stripe.checkouts).toHaveLength(0)
    expect(logs).toContainEqual(expect.objectContaining({ event: 'price_not_gbp', price: 'price_b_m', currency: 'EUR' }))
  })

  it('still list the plans, without an amount, when Stripe cannot be read', async () => {
    stripe.prices.clear()
    const plans = await listPlans()
    expect(plans.map((p) => p.tier)).toEqual(['free', 'basic', 'pro'])
    expect(plans[1].prices).toEqual({})
  })
})

describe('the published catalog', () => {
  it('is signed so the WALLET adopts it, and a tampered copy is refused', async () => {
    const out = await app.handle({ method: 'GET', path: '/v1/catalog', headers: {}, body: '' })
    const signed = out.body as { body: string; signature: string }
    expect(catalogSignatureValid(signed, SELLER.pk)).toBe(true)
    expect(acceptCatalog(signed, { verifySignature: (s) => catalogSignatureValid(s, SELLER.pk), current: BUNDLED_CATALOG }).accepted).toBe(true)
    expect(catalogSignatureValid({ ...signed, body: signed.body.replace('10000', '99999') }, SELLER.pk)).toBe(false)
    // #506: the free threshold is hard-coded in every merchant currency, with no FX table.
    const published = parseCatalog(signed.body)!
    expect(published.version).toBe(5)
    expect(published.fx).toBeUndefined()
    expect(published.tiers.free.limits.sales?.amounts).toEqual(FREE_TIER_AMOUNTS)
    expect(published.tiers.free.limits.sales?.amounts).toMatchObject({ GBP: 10000, NGN: 13000000, KES: 1200000, XOF: 65000 })
    expect(Object.keys(parseCatalog(signed.body)!.tiers)).toEqual(['free', 'basic', 'pro'])
    // #418: the bought tiers earn their badges from the catalog; Starter earns none.
    const tiers = parseCatalog(signed.body)!.tiers
    expect([tiers.free.badge, tiers.basic.badge, tiers.pro.badge]).toEqual([undefined, 'bronze', 'silver'])
  })
})
