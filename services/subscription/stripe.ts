/**
 * Stripe, over its REST API with `fetch`: Checkout for the purchase, Billing for renewals, the
 * Customer Portal for card and cancellation, and Tax on every invoice (#407 Q9, Q10).
 *
 * No SDK. Four calls and a signature check do not justify a dependency in an image whose other job
 * is signing licences (the same reasoning as `purchase-issuer`'s pinned, minimal install).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Overridable for stripe-mock and local runs (`STRIPE_API_BASE`). */
const API = (process.env.STRIPE_API_BASE ?? 'https://api.stripe.com').replace(/\/+$/, '') + '/v1'

export interface StripeClient {
  createCheckout(input: {
    priceId: string
    stallPubkey: string
    tier: string
    term: string
    successUrl: string
    cancelUrl: string
    automaticTax: boolean
    customerId?: string
  }): Promise<{ id: string; url: string }>
  createPortal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>
  /** A Price's amount, so the site shows what Checkout will charge, never a copy of it. */
  getPrice(priceId: string): Promise<StripePrice>
}

export interface StripePrice {
  /** Minor units, e.g. 1000 for £10. */
  unitAmount: number
  /** ISO 4217, upper case. */
  currency: string
  /** `month` or `year` for a recurring price. */
  interval?: string
}

/** Stripe's form encoding, nested keys as `a[b][c]`. */
export function formEncode(value: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue
    const key = prefix ? `${prefix}[${k}]` : k
    if (typeof v === 'object') {
      const nested = Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [String(i), x])) : (v as Record<string, unknown>)
      const inner = formEncode(nested, key)
      if (inner) parts.push(inner)
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`)
    }
  }
  return parts.join('&')
}

export function stripeClient(secretKey: string, fetchImpl: typeof fetch = fetch): StripeClient {
  const post = async (path: string, body: Record<string, unknown>) => {
    const r = await fetchImpl(`${API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode(body),
    })
    const json = (await r.json()) as Record<string, unknown>
    if (!r.ok) {
      const err = json.error as { message?: string } | undefined
      throw new Error(`stripe ${path} ${r.status}: ${err?.message ?? 'error'}`)
    }
    return json
  }
  const get = async (path: string) => {
    const r = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${secretKey}` } })
    const json = (await r.json()) as Record<string, unknown>
    if (!r.ok) {
      const err = json.error as { message?: string } | undefined
      throw new Error(`stripe ${path} ${r.status}: ${err?.message ?? 'error'}`)
    }
    return json
  }
  return {
    async getPrice(id) {
      const p = await get(`/prices/${encodeURIComponent(id)}`)
      const unitAmount = Number(p.unit_amount)
      if (!Number.isSafeInteger(unitAmount) || unitAmount < 0 || typeof p.currency !== 'string') {
        throw new Error(`stripe price ${id} has no fixed amount`)
      }
      const interval = (p.recurring as { interval?: string } | null | undefined)?.interval
      return { unitAmount, currency: p.currency.toUpperCase(), ...(interval ? { interval } : {}) }
    },
    async createCheckout(i) {
      // The stall pubkey travels in metadata on the SESSION and on the SUBSCRIPTION, so every
      // later invoice (each renewal) can be tied back to the key its licence must be locked to.
      const metadata = { stall_pubkey: i.stallPubkey, tier: i.tier, term: i.term }
      const s = await post('/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price: i.priceId, quantity: 1 }],
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
        client_reference_id: i.stallPubkey,
        customer: i.customerId,
        metadata,
        subscription_data: { metadata },
        automatic_tax: { enabled: i.automaticTax },
        // Reverse charge for EU/UK businesses needs their VAT number (#407 Q10).
        tax_id_collection: { enabled: i.automaticTax },
        billing_address_collection: i.automaticTax ? 'required' : 'auto',
        payment_method_types: ['card'],
        // Every plan is charged in GBP. Without this, an account with Adaptive Pricing on shows the
        // shopper a converted amount (e.g. €9.96 for the £8 Basic, seen on Stripe test Checkout).
        adaptive_pricing: { enabled: false },
      })
      return { id: String(s.id), url: String(s.url) }
    },
    async createPortal(i) {
      const s = await post('/billing_portal/sessions', { customer: i.customerId, return_url: i.returnUrl })
      return { url: String(s.url) }
    },
  }
}

/**
 * Verify `Stripe-Signature` over the RAW body (v1 scheme), within a tolerance.
 * The body must be the exact bytes received: a re-serialised JSON will not match.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  if (!header) return false
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=')
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()]
    }),
  )
  const t = Number(parts.t)
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  const signatures = header
    .split(',')
    .filter((p) => p.trim().startsWith('v1='))
    .map((p) => p.trim().slice(3))
  return signatures.some((sig) => {
    const a = Buffer.from(sig, 'hex')
    const b = Buffer.from(expected, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  })
}

/** Sign a payload the way Stripe does. For tests and the local webhook simulator. */
export function stripeSignatureHeader(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`
}
