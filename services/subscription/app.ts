/**
 * The subscription service's behaviour, as plain request -> response functions (#407 §6, §7).
 *
 * `server.ts` only adapts Node's http to these. Everything worth testing (who may do what, what a
 * Stripe event owes, what a hand grant mints) lives here and runs without a socket.
 *
 * Routes:
 *   GET  /v1/catalog                 public: the signed tier catalog wallets adopt
 *   GET  /v1/plans                   public: the plans a stall can choose here (Starter and tiers with a card price), with prices
 *   POST /v1/stripe/webhook          Stripe-signed: invoice.paid / subscription updates
 *   /v1/auth/*                       NAP login (auth.ts): init, complete, session, logout
 *   GET  /v1/me                      session, merchant: this stall's subscriptions and licences
 *   POST /v1/checkout                session, merchant: Stripe Checkout for {tier, term}
 *   POST /v1/portal                  session, merchant: Stripe Customer Portal (card, cancel)
 *   POST /v1/licences/resend         session, merchant: re-deliver this stall's current licences
 *   POST /v1/admin/grants            session, merchant, admin: issue a hand grant to any stall
 *   POST /v1/admin/revoke            session, merchant, admin: revoke a subscription (refund)
 *
 * Every route that is not public needs a NAP session whose role is `merchant` (#411). There is no
 * per-request signature any more: the session is the authentication.
 */
import { FREE_TIER, parseCatalog, type LicenceLimits, type TierCatalog } from '@imani/licence'

import { SubscriptionAuth } from './auth.ts'
import type { SubscriptionConfig } from './config.ts'
import { LicenceIssuer, signCatalog, type LicenceOrder, type Seller } from './issuer.ts'
import { Ledger, newSubscriptionId, type IssuedLicence, type SubscriptionRow } from './ledger.ts'
import type { MerchantReader } from './merchantRole.ts'
import type { StatusNotifier } from './statusNotifier.ts'
import { verifyStripeSignature, type StripeClient, type StripePrice } from './stripe.ts'

export interface Request {
  method: string
  path: string
  headers: Record<string, string | undefined>
  body: string
}

export interface Response {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export interface AppDeps {
  config: SubscriptionConfig
  ledger: Ledger
  issuer: Pick<LicenceIssuer, 'mint' | 'deliver' | 'revoke'>
  stripe: StripeClient
  seller: Seller
  /** The catalog JSON as published (snake_case). Read once at boot. */
  catalogBody: string
  /** Is this key a merchant (a live, signed `imani:merchant` record)? See merchantRole.ts. */
  merchantStanding: MerchantReader
  /** Tells the stall's wallet a subscription was cancelled or un-cancelled (statusNotifier.ts). */
  notifier?: StatusNotifier
  now?: () => number
  log?: (event: Record<string, unknown>) => void
  /** Tests only: NAP server overrides (clock, response padding). */
  napServerOptions?: ConstructorParameters<typeof SubscriptionAuth>[0]['serverOptions']
}

const HEX64 = /^[0-9a-f]{64}$/
const MAX_BODY = 16 * 1024
const TERM_SECONDS = { monthly: 31 * 86_400, annual: 366 * 86_400 } as const
const TERMS = ['monthly', 'annual'] as const
/** Every subscription is priced in pounds (www.imani.casa/pricing). A price in anything else is never sold. */
export const SUBSCRIPTION_CURRENCY = 'GBP'
/** How long a Stripe Price's amount is reused for the plans page. Prices are immutable; ids rotate. */
const PRICE_TTL_MS = 10 * 60_000

export function createApp(deps: AppDeps) {
  const now = () => Math.floor((deps.now?.() ?? Date.now()) / 1000)
  const log = deps.log ?? ((e) => console.log(JSON.stringify(e)))
  const catalog: TierCatalog = parseCatalog(deps.catalogBody) ?? (() => {
    throw new Error('the published catalog does not parse (parseCatalog returned null)')
  })()
  const signedCatalog = signCatalog(deps.catalogBody, deps.seller)
  // A price for a tier the catalog does not define would sell a licence the wallet cannot read.
  for (const key of Object.keys(deps.config.prices)) {
    const tier = key.split(':')[0]
    if (!catalog.tiers[tier] || tier === FREE_TIER) {
      throw new Error(`SUBSCRIPTION_PRICES names '${tier}', which the catalog does not sell`)
    }
  }

  const json = (status: number, body: unknown): Response => ({ status, body })
  /** The public URL of a path on this site: origin + mount path + path. */
  const site = (path: string) => `${deps.config.publicOrigin}${deps.config.basePath ?? ''}${path}`

  const auth = new SubscriptionAuth({
    site,
    merchantStanding: deps.merchantStanding,
    secureCookie: deps.config.publicOrigin.startsWith('https://'),
    cookiePath: deps.config.basePath || '/',
    serverOptions: deps.napServerOptions,
  })

  const isResponse = (x: unknown): x is Response => typeof (x as Response)?.status === 'number'

  function parseBody(req: Request): Record<string, unknown> | Response {
    if (req.body.length > MAX_BODY) return json(413, { error: 'request too large' })
    if (!req.body) return {}
    try {
      const v = JSON.parse(req.body) as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : json(400, { error: 'expected a JSON object' })
    } catch {
      return json(400, { error: 'invalid JSON' })
    }
  }

  /** Mint and deliver one licence, recording each step so a failure is resumable, never doubled. */
  async function issue(row: SubscriptionRow, licence: IssuedLicence): Promise<IssuedLicence> {
    const order: LicenceOrder = {
      key: licence.key,
      stallPubkey: row.stallPubkey,
      subscriptionId: row.subscriptionId,
      tier: row.tier,
      grantKind: row.grantKind,
      features: row.features ?? catalog.tiers[row.tier]?.features ?? [],
      limits: row.grantKind === 'custom' ? (row.limits as LicenceLimits | undefined) : undefined,
      validFrom: licence.validFrom,
      validTo: licence.validTo,
      paidAmountMinor: row.paidAmountMinor,
      paidCurrency: row.paidCurrency,
      pilot: row.pilot,
    }
    let next: IssuedLicence = { ...licence, attempts: licence.attempts + 1 }
    try {
      let raw: Record<string, unknown> | undefined
      if (!next.token) {
        const minted = await deps.issuer.mint(order)
        next = { ...next, state: 'minted', voucherId: minted.voucherId, token: minted.token }
        raw = minted.raw
        await save(row.subscriptionId, next)
      }
      await deps.issuer.deliver(row.stallPubkey, raw ?? { token: next.token, voucher_id: next.voucherId }, next.validTo)
      next = { ...next, state: 'delivered', lastError: undefined }
    } catch (error) {
      next = { ...next, state: next.token ? 'minted' : 'failed', lastError: String((error as Error).message ?? error) }
      log({ event: 'licence_issue_failed', subscription_id: row.subscriptionId, key: next.key, error: next.lastError })
    }
    await save(row.subscriptionId, next)
    return next
  }

  function save(subscriptionId: string, licence: IssuedLicence) {
    return deps.ledger.update((rows) => {
      const row = rows.find((r) => r.subscriptionId === subscriptionId)
      if (!row) return
      const i = row.licences.findIndex((l) => l.key === licence.key)
      if (i === -1) row.licences.push(licence)
      else row.licences[i] = licence
    })
  }

  // ------------------------------------------------------------------ Stripe events

  /**
   * `invoice.paid` owes exactly one licence per invoice, for that invoice's period. The first one
   * creates the ledger row from the subscription's metadata (set at checkout). A replay of the same
   * event finds the licence already recorded and does nothing but retry a failed delivery.
   */
  async function onInvoicePaid(invoice: Record<string, unknown>): Promise<Response> {
    const line = ((invoice.lines as { data?: Array<Record<string, unknown>> })?.data ?? [])[0] ?? {}
    const period = (line.period ?? {}) as { start?: number; end?: number }
    // Stripe moved these in API 2025-03-31 (basil): `subscription` and `subscription_details` now live
    // under `parent.subscription_details`. Read both, so a pinned or upgraded API version both work.
    const parentDetails = ((invoice.parent as { subscription_details?: Record<string, unknown> })?.subscription_details ??
      {}) as { subscription?: string; metadata?: Record<string, string> }
    const meta = {
      ...(parentDetails.metadata ?? {}),
      ...((invoice.subscription_details as { metadata?: Record<string, string> })?.metadata ?? {}),
      ...((line.metadata as Record<string, string>) ?? {}),
    }
    const stall = String(meta.stall_pubkey ?? '').toLowerCase()
    const tier = String(meta.tier ?? '')
    const term = String(meta.term ?? '') as 'monthly' | 'annual'
    const stripeSub = String(invoice.subscription ?? parentDetails.subscription ?? '')
    if (!HEX64.test(stall) || !catalog.tiers[tier] || !TERM_SECONDS[term] || !stripeSub) {
      log({ event: 'invoice_unattributable', invoice: invoice.id })
      // 200, not 4xx: Stripe would retry forever an event that will never carry what is missing.
      return json(200, { ignored: 'not an Imani subscription invoice' })
    }
    const validFrom = Number(period.start) || now()
    const validTo = Number(period.end) || validFrom + TERM_SECONDS[term]
    const key = `inv:${String(invoice.id)}`

    const { row, licence } = await deps.ledger.update((rows) => {
      let r = rows.find((x) => x.stripeSubscriptionId === stripeSub)
      if (!r) {
        r = {
          subscriptionId: newSubscriptionId(),
          stallPubkey: stall,
          tier,
          term,
          grantKind: 'subscription',
          status: 'active',
          stripeCustomerId: String(invoice.customer ?? ''),
          stripeSubscriptionId: stripeSub,
          paidAmountMinor: Number(invoice.amount_paid ?? 0),
          paidCurrency: String(invoice.currency ?? 'gbp').toUpperCase(),
          createdAt: now(),
          licences: [],
        }
        rows.push(r)
      }
      // A plan change on the Stripe side arrives as a new invoice with new metadata.
      r.tier = tier
      r.term = term
      r.paidAmountMinor = Number(invoice.amount_paid ?? r.paidAmountMinor)
      r.paidCurrency = String(invoice.currency ?? r.paidCurrency).toUpperCase()
      let l = r.licences.find((x) => x.key === key)
      if (!l) {
        l = { key, validFrom, validTo, state: 'owed', attempts: 0 }
        r.licences.push(l)
      }
      return { row: structuredClone(r), licence: structuredClone(l) }
    })
    if (row.status === 'revoked') return json(200, { ignored: 'subscription revoked' })
    if (licence.state === 'delivered') return json(200, { duplicate: true })
    const done = await issue(row, licence)
    // 500 on failure so Stripe retries the event; the ledger makes the retry resume, not repeat.
    return json(done.state === 'delivered' ? 200 : 500, { subscription_id: row.subscriptionId, state: done.state })
  }

  async function onSubscriptionChanged(sub: Record<string, unknown>): Promise<Response> {
    const id = String(sub.id ?? '')
    const cancelled = isCancelled(sub)
    const next = cancelled ? 'cancelled' : 'active'
    const changed = await deps.ledger.update((rows) => {
      const r = rows.find((x) => x.stripeSubscriptionId === id)
      if (!r || r.status === 'revoked' || r.status === next) return null
      r.status = next
      return { subscriptionId: r.subscriptionId, stallPubkey: r.stallPubkey }
    })
    log({ event: 'subscription_changed', stripe_subscription: id, status: next, changed: Boolean(changed) })
    // Tell the stall's wallet, which cannot learn it from the licence it holds (statusNotifier.ts).
    // Only on a real change, so Stripe's several `updated` events per action send one message.
    // Best effort: a lost message never fails the webhook, which Stripe would then retry forever.
    if (changed && deps.notifier) {
      const endsAt = endOf(sub)
      try {
        await deps.notifier.notify(changed.stallPubkey, {
          subscriptionId: changed.subscriptionId,
          status: next,
          ...(cancelled && endsAt ? { endsAt } : {}),
          at: now(),
        })
        log({ event: 'subscription_status_sent', subscription_id: changed.subscriptionId, status: next })
      } catch (error) {
        log({ event: 'subscription_status_failed', subscription_id: changed.subscriptionId, error: String((error as Error).message ?? error) })
      }
    }
    // Cancelling never revokes: the licence already paid for runs to its end (#407 §6).
    return json(200, { ok: true })
  }

  async function webhook(req: Request): Promise<Response> {
    if (!verifyStripeSignature(req.body, req.headers['stripe-signature'], deps.config.stripeWebhookSecret, now())) {
      return json(400, { error: 'bad signature' })
    }
    const event = JSON.parse(req.body) as { type?: string; data?: { object?: Record<string, unknown> } }
    const object = event.data?.object ?? {}
    switch (event.type) {
      case 'invoice.paid':
        return onInvoicePaid(object)
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return onSubscriptionChanged(object)
      default:
        return json(200, { ignored: event.type })
    }
  }

  // ------------------------------------------------------------------ routes

  async function handle(req: Request): Promise<Response> {
    const route = `${req.method} ${req.path.split('?')[0]}`
    switch (route) {
      case 'GET /health':
        return json(200, { ok: true })
      case 'GET /v1/catalog':
        // Readable from any origin: the wallet (wallet.imani.casa) fetches it cross-origin now that
        // this site has its own (#411). Safe to open: it is public and signed by the seller, the
        // wallet verifies the signature, and no credential is sent or honoured on this route.
        return {
          status: 200,
          body: signedCatalog,
          headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' },
        }
      case 'GET /v1/plans':
        return json(200, await plans())
      case 'POST /v1/stripe/webhook':
        return webhook(req)
    }

    if (req.path.startsWith('/v1/auth/')) {
      return (await auth.handle(req)) ?? json(404, { error: 'not found' })
    }

    const who = await auth.require(req)
    if (isResponse(who)) return who
    const body = parseBody(req)
    if (isResponse(body)) return body

    switch (route) {
      case 'GET /v1/me':
        return json(200, {
          pubkey: who.pubkey,
          roles: who.roles,
          admin: isAdmin(who.pubkey),
          subscriptions: (await deps.ledger.forStall(who.pubkey)).map(publicRow),
        })
      case 'POST /v1/checkout':
        return checkout(who.pubkey, body)
      case 'POST /v1/portal':
        return portal(who.pubkey)
      case 'POST /v1/licences/resend':
        return resend(who.pubkey)
      case 'POST /v1/admin/grants':
        return isAdmin(who.pubkey) ? grant(who.pubkey, body) : json(403, { error: 'not an administrator' })
      case 'POST /v1/admin/revoke':
        return isAdmin(who.pubkey) ? revoke(body) : json(403, { error: 'not an administrator' })
      default:
        return json(404, { error: 'not found' })
    }
  }

  const isAdmin = (pk: string) => deps.config.adminPubkeys.includes(pk)

  /**
   * The plans a stall can choose here: the free tier (Starter), and every tier with a card price.
   *
   * Being in the catalog is not enough. The catalog also defines what hand grants and partnerships
   * carry, and a tier that is arranged with us (Town / BID Partner: "Contact us" on
   * www.imani.casa/pricing) has no Stripe price, so it is never offered as an option here.
   */
  async function plans() {
    const listed = Object.entries(catalog.tiers).filter(
      ([name]) => name === FREE_TIER || TERMS.some((term) => deps.config.prices[`${name}:${term}`]),
    )
    return Promise.all(
      listed.map(async ([name, t]) => {
        const terms = TERMS.filter((term) => deps.config.prices[`${name}:${term}`])
        const prices: Partial<Record<(typeof TERMS)[number], { amount: number; currency: string }>> = {}
        for (const term of terms) {
          const p = await priceOf(deps.config.prices[`${name}:${term}`])
          if (p) prices[term] = { amount: p.unitAmount, currency: p.currency }
        }
        return { tier: name, features: t.features, limits: t.limits, terms, prices }
      }),
    )
  }

  const priceCache = new Map<string, { at: number; price: StripePrice }>()
  /**
   * A Price's amount from Stripe, so the page shows what Checkout charges. Null if Stripe is down,
   * and null for a price that is not in GBP: that is a configuration mistake, never something sold.
   */
  async function priceOf(id: string): Promise<StripePrice | null> {
    const hit = priceCache.get(id)
    const at = deps.now?.() ?? Date.now()
    if (hit && at - hit.at < PRICE_TTL_MS) return hit.price
    try {
      const price = await deps.stripe.getPrice(id)
      if (price.currency !== SUBSCRIPTION_CURRENCY) {
        log({ event: 'price_not_gbp', price: id, currency: price.currency })
        return null
      }
      priceCache.set(id, { at, price })
      return price
    } catch (error) {
      log({ event: 'price_unavailable', price: id, error: String((error as Error).message ?? error) })
      return hit?.price ?? null
    }
  }

  async function checkout(pubkey: string, body: Record<string, unknown>): Promise<Response> {
    const tier = String(body.tier ?? '')
    const term = String(body.term ?? '')
    const priceId = catalog.tiers[tier] ? deps.config.prices[`${tier}:${term}`] : undefined
    if (!priceId) return json(400, { error: `no ${term} price for the ${tier} plan` })
    // Only a price Stripe confirms is in GBP is sold. Stripe being unreachable fails below anyway.
    if (!(await priceOf(priceId))) {
      log({ event: 'checkout_refused_price', tier, term })
      return json(502, { error: 'Checkout is unavailable right now. Please try again in a few minutes.' })
    }
    const existing = (await deps.ledger.forStall(pubkey)).find((r) => r.stripeCustomerId)
    let session: { url: string }
    try {
      session = await deps.stripe.createCheckout({
        priceId,
        stallPubkey: pubkey,
        tier,
        term,
        successUrl: `${site('/done')}?session={CHECKOUT_SESSION_ID}`,
        cancelUrl: site('/plans'),
        automaticTax: deps.config.automaticTax,
        customerId: existing?.stripeCustomerId,
      })
    } catch (error) {
      // A 502 with a sentence, not a bare 500: "checkout is unavailable" is something the stall can
      // act on (try later), and the cause is logged for us.
      log({ event: 'checkout_failed', tier, term, error: String((error as Error).message ?? error) })
      return json(502, { error: 'Checkout is unavailable right now. Please try again in a few minutes.' })
    }
    return json(200, { url: session.url })
  }

  async function portal(pubkey: string): Promise<Response> {
    const customer = (await deps.ledger.forStall(pubkey)).find((r) => r.stripeCustomerId)?.stripeCustomerId
    if (!customer) return json(404, { error: 'no card subscription for this stall yet' })
    return json(200, await deps.stripe.createPortal({ customerId: customer, returnUrl: site('/account') }))
  }

  /** Re-deliver every licence still in force (or retry one that failed): covers a lost DM. */
  async function resend(pubkey: string): Promise<Response> {
    const rows = await deps.ledger.forStall(pubkey)
    let sent = 0
    for (const row of rows) {
      if (row.status === 'revoked') continue
      for (const l of row.licences) {
        if (l.validTo <= now()) continue
        const done = await issue(row, l)
        if (done.state === 'delivered') sent += 1
      }
    }
    return json(200, { sent })
  }

  /**
   * A hand grant (#407 §7): any limits, any window, to any stall, by an allowlisted admin. Recorded
   * with who issued it and why, then minted and delivered like any licence.
   */
  async function grant(admin: string, body: Record<string, unknown>): Promise<Response> {
    const stall = String(body.stall_pubkey ?? '').toLowerCase()
    if (!HEX64.test(stall)) return json(400, { error: 'stall_pubkey must be 64 hex' })
    const days = Number(body.days ?? 30)
    if (!Number.isSafeInteger(days) || days < 1 || days > 3660) return json(400, { error: 'days must be 1 to 3660' })
    const reason = String(body.reason ?? '').trim()
    if (!reason) return json(400, { error: 'a reason is required, for the audit trail' })
    const limits = parseLimits(body.limits)
    if (isResponse(limits)) return limits
    const features = Array.isArray(body.features) ? body.features.filter((f): f is string => typeof f === 'string' && f.length > 0) : []
    if (!limits && features.length === 0) return json(400, { error: 'a grant must lift a limit or name a feature' })
    const validFrom = typeof body.valid_from === 'number' ? body.valid_from : now()
    const currency = String(body.currency ?? 'GBP').toUpperCase()

    const row: SubscriptionRow = {
      subscriptionId: newSubscriptionId(),
      stallPubkey: stall,
      tier: 'custom',
      term: 'custom',
      grantKind: 'custom',
      status: 'active',
      limits,
      features,
      issuedBy: admin,
      reason,
      pilot: body.pilot === true,
      paidAmountMinor: 0,
      paidCurrency: /^[A-Z]{3}$/.test(currency) ? currency : 'GBP',
      createdAt: now(),
      licences: [{ key: `grant:${crypto.randomUUID()}`, validFrom, validTo: validFrom + days * 86_400, state: 'owed', attempts: 0 }],
    }
    await deps.ledger.update((rows) => {
      rows.push(row)
    })
    log({ event: 'grant_issued', by: admin, to: stall, subscription_id: row.subscriptionId, reason })
    const done = await issue(row, row.licences[0])
    return json(done.state === 'delivered' ? 201 : 502, { subscription_id: row.subscriptionId, state: done.state, error: done.lastError })
  }

  async function revoke(body: Record<string, unknown>): Promise<Response> {
    const id = String(body.subscription_id ?? '')
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return json(400, { error: 'subscription_id is malformed' })
    await deps.issuer.revoke(id, String(body.reason ?? ''))
    await deps.ledger.update((rows) => {
      const r = rows.find((x) => x.subscriptionId === id)
      if (r) r.status = 'revoked'
    })
    return json(200, { revoked: id })
  }

  return { handle }
}

/**
 * Has the stall cancelled this Stripe subscription, now or for later?
 *
 * Stripe says so in more than one way, by API version and by how it was cancelled:
 *  - `status: canceled` (or `ended_at`): it has ended;
 *  - `cancel_at_period_end: true`: it stops at the period end (older portal behaviour);
 *  - `cancel_at` set: it stops at that time. API 2025-03-31 onward, the customer portal cancels this
 *    way and leaves `cancel_at_period_end` false (seen on 2026-02-25.clover, sub_738c90f3fbfe6e46).
 * Undoing a cancellation clears `cancel_at` and `cancel_at_period_end`, so it reads as active again.
 */
export function isCancelled(sub: Record<string, unknown>): boolean {
  if (sub.status === 'canceled' || sub.ended_at) return true
  if (sub.cancel_at_period_end === true) return true
  return typeof sub.cancel_at === 'number' && sub.cancel_at > 0
}

/** When a cancelled subscription stops, in Unix seconds, from whichever field Stripe set. */
function endOf(sub: Record<string, unknown>): number | undefined {
  for (const v of [sub.ended_at, sub.cancel_at, sub.current_period_end]) {
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v
  }
  // API 2025-03-31+: the period end lives on the subscription's item.
  const item = ((sub.items as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [])[0]
  const end = item?.current_period_end
  return typeof end === 'number' && end > 0 ? end : undefined
}

/** Strict, as `@imani/licence` reads them: an unreadable limit is refused, never read as unlimited. */
function parseLimits(raw: unknown): LicenceLimits | undefined | Response {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) return { status: 400, body: { error: 'limits must be an object' } }
  const r = raw as { sales?: unknown; terminals?: unknown }
  const out: LicenceLimits = {}
  if (r.terminals !== undefined) {
    if (r.terminals !== null && !(Number.isSafeInteger(r.terminals) && (r.terminals as number) >= 0)) {
      return { status: 400, body: { error: 'limits.terminals must be a count or null' } }
    }
    out.terminals = r.terminals as number | null
  }
  if (r.sales !== undefined) {
    if (r.sales === null) out.sales = null
    else {
      const amounts = (r.sales as { amounts?: unknown }).amounts
      if (!amounts || typeof amounts !== 'object') return { status: 400, body: { error: 'limits.sales.amounts is required' } }
      const clean: Record<string, number> = {}
      for (const [c, a] of Object.entries(amounts as Record<string, unknown>)) {
        if (!/^[A-Z]{3}$/.test(c) || !Number.isSafeInteger(a) || (a as number) < 0) {
          return { status: 400, body: { error: `limits.sales.amounts.${c} must be minor units` } }
        }
        clean[c] = a as number
      }
      out.sales = { period: 'window', amounts: clean }
    }
  }
  return out.sales !== undefined || out.terminals !== undefined ? out : undefined
}

/** What the stall sees of its own row: no Stripe ids, no admin notes. */
function publicRow(r: SubscriptionRow) {
  return {
    subscription_id: r.subscriptionId,
    tier: r.tier,
    term: r.term,
    kind: r.grantKind,
    status: r.status,
    limits: r.limits,
    has_card: Boolean(r.stripeCustomerId),
    licences: r.licences.map((l) => ({ valid_from: l.validFrom, valid_to: l.validTo, state: l.state, token: l.state === 'delivered' ? l.token : undefined })),
  }
}
