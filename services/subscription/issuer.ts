/**
 * Minting and delivering one licence through gateway-customer: the same two calls
 * `scripts/sell-subscription.mjs` makes, as the seller (#407 §6, §7).
 *
 * The metadata shape is the one `src/lib/licenceIssue.ts` defines and `@imani/licence` reads back;
 * `licenceMetadataJson` is imported rather than restated, so the service cannot drift from the
 * wallet's reader the way a copy could.
 *
 * Idempotent per licence `key`: the mint carries it as `Idempotency-Key`, so a webhook retried after
 * a timeout gets the SAME voucher back rather than a second licence.
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'

import type { LicenceLimits } from '@imani/licence'
import { licenceMetadataJson } from '../../src/lib/licenceIssue.ts'

export interface Seller {
  sk: Uint8Array
  pk: string
}

export function sellerFrom(nsec: string): Seller {
  const decoded = nip19.decode(nsec)
  if (decoded.type !== 'nsec') throw new Error('IMANI_SUBSCRIPTIONS_SELLER_NSEC is not an nsec')
  return { sk: decoded.data, pk: getPublicKey(decoded.data) }
}

export interface LicenceOrder {
  /** Idempotency: one per Stripe invoice, or per grant. */
  key: string
  stallPubkey: string
  subscriptionId: string
  tier: string
  grantKind: 'subscription' | 'custom'
  features: readonly string[]
  limits?: LicenceLimits
  validFrom: number
  validTo: number
  paidAmountMinor: number
  paidCurrency: string
  pilot?: boolean
}

export interface MintedLicence {
  voucherId: string
  token: string
}

export interface IssuerDeps {
  walletUrl: string
  /**
   * The public base URL gateway-customer binds NIP-98 `u` tags to (its
   * GATEWAY_SECURITY_NIP98_PUBLIC_BASE_URL). Defaults to `walletUrl`. Differs when the service
   * reaches the gateway on an internal address (http://gateway-customer:8082) while the gateway
   * names its public origin: the request goes to `walletUrl`, the signature names this.
   */
  nip98BaseUrl?: string
  edgeSecret: string
  internalRelay: string
  seller: Seller
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Polls for the token, at 2 s intervals. */
  tokenTimeoutMs?: number
}

function nip98(sk: Uint8Array, url: string, method: string, body?: string): string {
  const tags = [
    ['u', url],
    ['method', method],
  ]
  if (body) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  tags.push(['nonce', bytesToHex(crypto.getRandomValues(new Uint8Array(16)))])
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk)
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

/** The seller's `merchant` warrant (src/lib/issuanceWarrant.ts): a wallet refuses a coupon without one. */
function warrant(seller: Seller, saleTotal: number, faceDecimals: number, unit: string): string {
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const digest = sha256(new TextEncoder().encode([seller.pk, String(saleTotal), String(faceDecimals), unit, nonce].join('\u001f')))
  return JSON.stringify({
    form: 'merchant',
    sale_total: saleTotal,
    face_decimals: faceDecimals,
    unit,
    nonce,
    sig: bytesToHex(schnorr.sign(digest, seller.sk)),
  })
}

/** Whole days covering the window, at least one: the gateway takes `expires_in_days`. */
function daysFor(order: LicenceOrder, nowSeconds: number): number {
  return Math.max(1, Math.ceil((order.validTo - nowSeconds) / 86_400))
}

export function mintBody(order: LicenceOrder, seller: Seller, nowSeconds = Math.floor(Date.now() / 1000)) {
  // gateway-customer refuses face_value 0 (VALIDATION_001, staging 2026-10-27): a free grant is 1p.
  const face = Math.max(1, order.paidAmountMinor)
  const decimals = order.paidCurrency === 'sat' ? 0 : 2
  const metadata = licenceMetadataJson({
    lockKey: order.stallPubkey,
    subscriptionId: order.subscriptionId,
    features: order.features as never,
    pilot: order.pilot,
    paidAmountMinor: order.paidAmountMinor,
    paidCurrency: order.paidCurrency,
    tier: order.tier,
    validFrom: order.validFrom,
    limits: order.limits,
    grantKind: order.grantKind,
  })
  return {
    face_value: face,
    face_unit: order.paidCurrency,
    face_decimals: decimals,
    backing_strategy: 'FIXED',
    issuer_id: seller.pk,
    memo: order.grantKind === 'custom' ? 'Imani plan grant' : `Imani ${order.tier} plan`,
    expires_in_days: daysFor(order, nowSeconds),
    merchant_metadata: JSON.parse(metadata) as Record<string, unknown>,
    issuance_warrant: warrant(seller, face, decimals, order.paidCurrency),
  }
}

export class LicenceIssuer {
  private readonly fetch: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly deps: IssuerDeps
  constructor(deps: IssuerDeps) {
    this.deps = deps
    this.fetch = deps.fetch ?? fetch
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  private headers(url: string, method: string, body?: string, extra: Record<string, string> = {}) {
    return {
      'Content-Type': 'application/json',
      Authorization: nip98(this.deps.seller.sk, this.signedUrl(url), method, body),
      'X-Auth-Pubkey': this.deps.seller.pk,
      'X-Edge-Auth': this.deps.edgeSecret,
      ...extra,
    }
  }

  /** The URL a NIP-98 `u` tag names for a request to `url`: the same path on the public base. */
  private signedUrl(url: string): string {
    const base = this.deps.nip98BaseUrl?.replace(/\/+$/, '')
    return base && url.startsWith(this.deps.walletUrl) ? base + url.slice(this.deps.walletUrl.length) : url
  }

  /** Mint (idempotent on `order.key`) and wait for the token. */
  async mint(order: LicenceOrder): Promise<MintedLicence & { raw: Record<string, unknown> }> {
    const url = `${this.deps.walletUrl}/api/v1/wallet/vouchers`
    const body = JSON.stringify(mintBody(order, this.deps.seller))
    const r = await this.fetch(url, {
      method: 'POST',
      headers: this.headers(url, 'POST', body, { 'Idempotency-Key': `licence:${order.key}` }),
      body,
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`mint failed ${r.status}: ${text.slice(0, 300)}`)
    let voucher = JSON.parse(text) as Record<string, unknown>
    const deadline = Date.now() + (this.deps.tokenTimeoutMs ?? 60_000)
    while (!(voucher.token && voucher.status === 'ISSUED')) {
      if (Date.now() > deadline) throw new Error(`voucher ${String(voucher.voucher_id)} never produced a token`)
      await this.sleep(2000)
      const getUrl = `${this.deps.walletUrl}/api/v1/wallet/vouchers/${String(voucher.voucher_id)}`
      const g = await this.fetch(getUrl, { headers: this.headers(getUrl, 'GET') })
      if (g.ok) voucher = (await g.json()) as Record<string, unknown>
    }
    return { voucherId: String(voucher.voucher_id), token: String(voucher.token), raw: voucher }
  }

  /** Gift-wrapped DM to the stall, the path every coupon takes. */
  async deliver(stallPubkey: string, v: Record<string, unknown>, expiresAt: number): Promise<void> {
    const url = `${this.deps.walletUrl}/api/v1/dm/tokens/send`
    const body = JSON.stringify({
      recipient_pubkey: stallPubkey,
      token: v.token,
      memo: v.memo,
      voucher_id: v.voucher_id,
      face_value: v.face_value,
      face_unit: v.face_unit,
      face_decimals: v.face_decimals,
      token_amount: v.token_amount,
      backing_strategy: v.backing_strategy,
      issuer_id: this.deps.seller.pk,
      sender_pubkey: this.deps.seller.pk,
      expires_at: expiresAt,
      relay_urls: [this.deps.internalRelay],
    })
    const r = await this.fetch(url, { method: 'POST', headers: this.headers(url, 'POST', body), body })
    if (!r.ok) throw new Error(`deliver failed ${r.status}: ${(await r.text()).slice(0, 300)}`)
  }

  /**
   * Hand a signed event to gateway-customer's nostrdb index (`POST /api/v1/nostr/events`), which
   * re-checks its id and signature before storing it. The wallet's DM poll reads that index.
   */
  async storeEvent(event: { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }): Promise<void> {
    const url = `${this.deps.walletUrl}/api/v1/nostr/events`
    // The gateway's NostrEventDto reads `createdAt` (camelCase) and ignores unknown fields, so a
    // NIP-01 `created_at` arrives as 0 and the recomputed id never matches (EVENT_ID_MISMATCH, seen
    // on the local deployment). Send the DTO's own names.
    const body = JSON.stringify({
      id: event.id,
      pubkey: event.pubkey,
      createdAt: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    })
    const r = await this.fetch(url, { method: 'POST', headers: this.headers(url, 'POST', body), body })
    if (!r.ok) throw new Error(`store event failed ${r.status}: ${(await r.text()).slice(0, 300)}`)
  }

  /** Revoke a subscription at gateway-customer (#226): every licence of it stops counting. NIP-98 only. */
  async revoke(subscriptionId: string, reason: string): Promise<void> {
    const url = `${this.deps.walletUrl}/api/v1/wallet/licences/revoke`
    const body = JSON.stringify(reason ? { subscription_id: subscriptionId, reason } : { subscription_id: subscriptionId })
    const r = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: nip98(this.deps.seller.sk, this.signedUrl(url), 'POST', body) },
      body,
    })
    if (!r.ok) throw new Error(`revoke failed ${r.status}: ${(await r.text()).slice(0, 300)}`)
  }
}

/** Sign the published catalog the way the wallet verifies it (`catalogSignatureValid`). */
export function signCatalog(body: string, seller: Seller): { body: string; signature: string } {
  return { body, signature: bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(body)), seller.sk)) }
}
