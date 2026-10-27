/**
 * @vitest-environment node
 *
 * subscription.imani.casa end to end at the service boundary: real NIP-98 from a stall key, real
 * Stripe webhook signatures, a real ledger on disk, and the licence it mints read back through the
 * wallet's OWN reader and verifier. Only the gateway and Stripe's API are faked, by URL.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { beforeEach, describe, expect, it } from 'vitest'
import { acceptCatalog, BUNDLED_CATALOG, entitlementOf, licenceOf, parseCatalog } from '@imani/licence'

import { createApp, type Request } from '../app.ts'
import type { SubscriptionConfig } from '../config.ts'
import { LicenceIssuer, sellerFrom } from '../issuer.ts'
import { Ledger } from '../ledger.ts'
import { stripeSignatureHeader, type StripeClient } from '../stripe.ts'
import { catalogSignatureValid } from '../../../src/lib/entitlement.ts'

const ORIGIN = 'https://subscription.test'
const WALLET = 'http://gateway:8082'
const WEBHOOK_SECRET = 'whsec_test'
const SELLER_SK = generateSecretKey()
const SELLER = sellerFrom(nip19.nsecEncode(SELLER_SK))
const STALL_SK = generateSecretKey()
const STALL = getPublicKey(STALL_SK)
const ADMIN_SK = generateSecretKey()
const ADMIN = getPublicKey(ADMIN_SK)
const CATALOG = (await readFile(join(__dirname, '..', 'catalog.json'), 'utf8')).trim()

function sign(sk: Uint8Array, method: string, path: string, body = ''): string {
  const tags = [
    ['u', `${ORIGIN}${path}`],
    ['method', method],
  ]
  if (body) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  tags.push(['nonce', bytesToHex(crypto.getRandomValues(new Uint8Array(8)))])
  const e = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk)
  return `Nostr ${Buffer.from(JSON.stringify(e)).toString('base64')}`
}

const req = (sk: Uint8Array | null, method: string, path: string, payload?: unknown): Request => {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  return { method, path, body, headers: sk ? { authorization: sign(sk, method, path, body) } : {} }
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

const fakeStripe = (): StripeClient & { checkouts: unknown[] } => {
  const checkouts: unknown[] = []
  return {
    checkouts,
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

beforeEach(async () => {
  gateway = fakeGateway()
  stripe = fakeStripe()
  ledger = new Ledger(join(await mkdtemp(join(tmpdir(), 'sub-')), 'ledger.json'))
  const config: SubscriptionConfig = {
    publicOrigin: ORIGIN,
    basePath: '',
    walletUrl: WALLET,
    edgeSecret: 'edge',
    internalRelay: 'ws://relay',
    sellerNsec: '',
    stripeSecretKey: 'sk',
    stripeWebhookSecret: WEBHOOK_SECRET,
    prices: { 'basic:monthly': 'price_b_m', 'pro:annual': 'price_p_a' },
    adminPubkeys: [ADMIN],
    ledgerPath: '',
    catalogPath: '',
    port: 0,
    automaticTax: true,
  }
  app = createApp({
    config,
    ledger,
    seller: SELLER,
    stripe,
    catalogBody: CATALOG,
    issuer: new LicenceIssuer({ walletUrl: WALLET, edgeSecret: 'edge', internalRelay: 'ws://relay', seller: SELLER, fetch: gateway.fetchImpl, sleep: async () => {} }),
    log: () => {},
  })
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

describe('signing in is a signature, nothing else', () => {
  it('refuses an unsigned or replayed request, and answers a signed one for that key only', async () => {
    expect((await app.handle(req(null, 'GET', '/v1/me'))).status).toBe(401)
    const r = req(STALL_SK, 'GET', '/v1/me')
    const ok = await app.handle(r)
    expect(ok).toMatchObject({ status: 200, body: { pubkey: STALL, admin: false, subscriptions: [] } })
    expect((await app.handle(r)).status).toBe(401)
  })

  it('refuses a signature for a different path or body', async () => {
    const r = req(STALL_SK, 'POST', '/v1/checkout', { tier: 'basic', term: 'monthly' })
    expect((await app.handle({ ...r, path: '/v1/portal' })).status).toBe(401)
    expect((await app.handle({ ...r, body: JSON.stringify({ tier: 'pro', term: 'annual' }) })).status).toBe(401)
  })
})

describe('buying a plan', () => {
  it('opens Stripe Checkout for the stall, card only, with tax and the stall key in metadata', async () => {
    const out = await app.handle(req(STALL_SK, 'POST', '/v1/checkout', { tier: 'basic', term: 'monthly' }))
    expect(out).toMatchObject({ status: 200, body: { url: 'https://checkout.stripe.test/cs_1' } })
    expect(stripe.checkouts[0]).toMatchObject({ priceId: 'price_b_m', stallPubkey: STALL, tier: 'basic', term: 'monthly', automaticTax: true })
  })

  it('refuses a tier or term with no price', async () => {
    expect((await app.handle(req(STALL_SK, 'POST', '/v1/checkout', { tier: 'pro', term: 'monthly' }))).status).toBe(400)
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
    expect(ent).toMatchObject({ tier: 'basic', terminals: 3, sales: { amount: 100000, period: 'month' } })
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

  it('shows the stall its own subscription and lets it re-send a lost licence', async () => {
    const end = Math.floor(Date.now() / 1000) + 10 * 86_400
    await app.handle(invoicePaid('in_1', end - 30 * 86_400, end))
    const me = await app.handle(req(STALL_SK, 'GET', '/v1/me'))
    expect(me.body).toMatchObject({ subscriptions: [{ tier: 'basic', kind: 'subscription', has_card: true, licences: [{ state: 'delivered' }] }] })
    expect(JSON.stringify(me.body)).not.toContain('cus_1')
    const resent = await app.handle(req(STALL_SK, 'POST', '/v1/licences/resend'))
    expect(resent).toMatchObject({ status: 200, body: { sent: 1 } })
    expect(gateway.minted).toHaveLength(1)
    expect(gateway.delivered).toHaveLength(2)
  })
})

describe('hand grants (#407 §7)', () => {
  const grantBody = { stall_pubkey: STALL, limits: { sales: { amounts: { GBP: 20000 } } }, days: 30, reason: 'free tier used up, pilot' }

  it('only an admin may issue one', async () => {
    expect((await app.handle(req(STALL_SK, 'POST', '/v1/admin/grants', grantBody))).status).toBe(403)
    expect(gateway.minted).toHaveLength(0)
  })

  it('raises a free stall to 200 for 30 days from now, recorded with who and why', async () => {
    const out = await app.handle(req(ADMIN_SK, 'POST', '/v1/admin/grants', grantBody))
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
      expect((await app.handle(req(ADMIN_SK, 'POST', '/v1/admin/grants', bad))).status).toBe(400)
    }
    expect(gateway.minted).toHaveLength(0)
  })
})

describe('the published catalog', () => {
  it('is signed so the WALLET adopts it, and a tampered copy is refused', async () => {
    const out = await app.handle({ method: 'GET', path: '/v1/catalog', headers: {}, body: '' })
    const signed = out.body as { body: string; signature: string }
    expect(catalogSignatureValid(signed, SELLER.pk)).toBe(true)
    expect(acceptCatalog(signed, { verifySignature: (s) => catalogSignatureValid(s, SELLER.pk), current: BUNDLED_CATALOG }).accepted).toBe(true)
    expect(catalogSignatureValid({ ...signed, body: signed.body.replace('10000', '99999') }, SELLER.pk)).toBe(false)
    expect(parseCatalog(signed.body)?.fx?.XAF).toEqual({ perUsd: 600, decimals: 0 })
  })
})
