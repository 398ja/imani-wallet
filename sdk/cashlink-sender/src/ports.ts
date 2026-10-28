/**
 * The engine's ports, for a server-side caller (#366).
 *
 * `src/lib/cashlinkFlow.ts` is the wallet app's Cashlink engine: arming, taking back, re-forming and
 * restoring, written against PORTS so a test (or another runtime) can supply the I/O. The app's own
 * ports are browser-shaped (relative URLs, cookies, localStorage). These are the same contracts for
 * a Node process talking to an Imani deployment with absolute URLs, NIP-98 signed by whichever key
 * the engine names, and storing nothing: what to keep is the caller's (`keep`).
 *
 * The engine is used AS IS. That is the point: an employer's integration gets exactly the rules the
 * app follows (never a locktime without a refund, burn witnessed by the refund key, the same lock and
 * re-sign checks, NUT-09 recovery), not a second implementation of them.
 */
import { hashToCurve } from '@cashu/crypto/modules/common'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'
import { finalizeEvent } from 'nostr-tools/pure'

import type { CashlinkGateway, CashlinkMint, CashlinkPorts, GatewayAnswer, KeptCoupon, SwapAnswer } from '../../../src/lib/cashlinkFlow'
import type { GiftWrap, ProofState } from '../../../src/lib/giftLink'
import type { BlindSignatureResponse } from '../../../src/lib/walletSwap'

export interface Endpoints {
  /**
   * The gateway as callers reach it (the edge): `/api/v1/wallet/vouchers/cashlink/*`,
   * `/api/v1/wallet/cashlink/refunds`, `/api/v1/nostr/events`, `/api/v1/nostr/query`.
   */
  gatewayUrl: string
  /** The mint the coupons are at, as the coupons name it (`m`). Only this one is ever spoken to. */
  mintUrl: string
  /**
   * Where to reach that mint from this process, when it differs from the URL the coupons name (a
   * private address, a local stack's port mapping). Defaults to `mintUrl`.
   */
  mintTransportUrl?: string
  /** The public origin NIP-98 events are bound to (`u` tag). Defaults to `gatewayUrl`. */
  publicOrigin?: string
}

export interface SigningKey {
  /** 32-byte secret key. Never sent anywhere; signs NIP-98 events locally. */
  secret: Uint8Array
}

const trim = (u: string) => u.trim().replace(/\/+$/, '')

/** A NIP-98 `Authorization` header, signed locally with `key`, with a nonce (as the app does). */
export function nip98(key: Uint8Array, url: string, method: string, body?: string): string {
  const tags: string[][] = [
    ['u', url],
    ['method', method.toUpperCase()],
  ]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  tags.push(['nonce', bytesToHex(randomBytes(16))])
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, key)
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

/**
 * The mint (NUT-01/02/03/07/09), with nothing but Content-Type: no redemption declaration ever.
 * `route` maps the mint URL a coupon names to the URL this process reaches it at.
 */
export function nodeMint(fetchImpl: typeof fetch = fetch, timeoutMs = 20_000, route: (mintUrl: string) => string = trim): CashlinkMint {
  const get = (url: string) => fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
  const post = (url: string, body: unknown) =>
    fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  const trimRoute = (u: string) => trim(route(u))
  return {
    async activeKeysetId(mintUrl) {
      const r = await get(`${trimRoute(mintUrl)}/v1/keysets`)
      if (!r.ok) throw new Error(`keysets HTTP ${r.status}`)
      const { keysets } = (await r.json()) as { keysets?: { id: string; unit: string; active: boolean }[] }
      const active = keysets?.find((k) => k.active && k.unit === 'sat')
      if (!active) throw new Error('no active sat keyset')
      return active.id
    },
    async keys(mintUrl, keysetId) {
      const r = await get(`${trimRoute(mintUrl)}/v1/keys/${keysetId}`)
      if (!r.ok) throw new Error(`keys HTTP ${r.status}`)
      const { keysets } = (await r.json()) as { keysets?: { id: string; keys: Record<string, string> }[] }
      const k = keysets?.[0]
      if (!k || k.id !== keysetId || !k.keys) throw new Error('keys for another keyset')
      return k.keys
    },
    async swap(mintUrl, inputs, outputs): Promise<SwapAnswer> {
      const r = await post(`${trimRoute(mintUrl)}/v1/swap`, {
        inputs: inputs.map(({ amount, id, secret, C, witness }) => ({ amount, id, secret, C, ...(witness ? { witness } : {}) })),
        outputs: outputs.map(({ amount, id, B_ }) => ({ amount, id, B_ })),
      })
      const body = (await r.json().catch(() => null)) as { signatures?: BlindSignatureResponse[]; code?: number; detail?: string } | null
      if (r.ok && Array.isArray(body?.signatures)) return { kind: 'signed', signatures: body.signatures }
      const code = Number(body?.code)
      if (code === 11001 || code === 11003) return { kind: 'spent' }
      if (code === 12002) return { kind: 'inactive' }
      // A 5xx may have signed: thrown, so the engine leaves it for NUT-09 on the next run.
      if (r.status >= 500 || r.ok) throw new Error(`swap HTTP ${r.status}`)
      return { kind: 'refused', ...(Number.isFinite(code) ? { code } : {}), ...(body?.detail ? { detail: body.detail } : {}) }
    },
    async restore(mintUrl, outputs) {
      const r = await post(`${trimRoute(mintUrl)}/v1/restore`, { outputs: outputs.map(({ amount, id, B_ }) => ({ amount, id, B_ })) })
      if (!r.ok) throw new Error(`restore HTTP ${r.status}`)
      const body = (await r.json()) as { outputs?: { B_: string }[]; signatures?: BlindSignatureResponse[] }
      if (!Array.isArray(body.outputs)) throw new Error('restore without outputs')
      return { outputs: body.outputs, signatures: body.signatures ?? [] }
    },
    async states(mintUrl, secrets): Promise<ProofState[]> {
      const Ys = secrets.map((s) => hashToCurve(new TextEncoder().encode(s)).toHex(true))
      const unknown = secrets.map((): ProofState => 'UNKNOWN')
      try {
        const r = await post(`${trimRoute(mintUrl)}/v1/checkstate`, { Ys })
        if (!r.ok) return unknown
        const { states } = (await r.json()) as { states?: { state?: string }[] }
        if (!Array.isArray(states) || states.length !== secrets.length) return unknown
        return states.map((s): ProofState => (s.state === 'UNSPENT' || s.state === 'SPENT' || s.state === 'PENDING' ? s.state : 'UNKNOWN'))
      } catch {
        return unknown
      }
    },
  }
}

/**
 * The gateway, NIP-98 signed. The engine names the signer for each call (the link key for a
 * deposit, the refund key for a relay fetch); calls it does not name are signed by the sender's own
 * key, as the app's session would.
 */
export function nodeGateway(endpoints: Endpoints, sender: SigningKey, fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): CashlinkGateway {
  const base = trim(endpoints.gatewayUrl)
  const origin = trim(endpoints.publicOrigin ?? endpoints.gatewayUrl)
  return {
    async call(method, path, body, signer): Promise<GatewayAnswer> {
      const text = body === undefined ? undefined : JSON.stringify(body)
      let authorization: string
      if (signer) {
        // The engine's signer (link or refund key) signs the same event shape through its own API.
        const tags: string[][] = [['u', `${origin}${path}`], ['method', method]]
        if (text !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(text)))])
        tags.push(['nonce', bytesToHex(randomBytes(16))])
        const event = await signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' })
        authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
      } else {
        authorization = nip98(sender.secret, `${origin}${path}`, method, text)
      }
      const r = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: authorization, ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(text !== undefined ? { body: text } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const parsed = (await r.json().catch(() => null)) as Record<string, unknown> | null
      return { status: r.status, body: parsed }
    },
  }
}

/** Publish a signed event through the gateway (`POST /api/v1/nostr/events`), NIP-98 by `key`. */
export async function publishEvent(endpoints: Endpoints, key: Uint8Array, event: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const path = '/api/v1/nostr/events'
  const body = JSON.stringify({
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  })
  const r = await fetchImpl(`${trim(endpoints.gatewayUrl)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: nip98(key, `${trim(endpoints.publicOrigin ?? endpoints.gatewayUrl)}${path}`, 'POST', body) },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })
  return r.ok
}

/** Every kind-1059 wrap addressed to `linkPub`, read through the gateway, signed by the link key. */
export async function queryWraps(endpoints: Endpoints, linkKey: Uint8Array, linkPub: string, fetchImpl: typeof fetch = fetch): Promise<GiftWrap[]> {
  const path = '/api/v1/nostr/query'
  const body = JSON.stringify({ kinds: [1059], pTags: [linkPub], limit: 50 })
  const r = await fetchImpl(`${trim(endpoints.gatewayUrl)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: nip98(linkKey, `${trim(endpoints.publicOrigin ?? endpoints.gatewayUrl)}${path}`, 'POST', body) },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })
  if (!r.ok) throw new Error(`nostr/query answered ${r.status}`)
  const json = (await r.json()) as { events?: Array<Record<string, unknown>> }
  return (Array.isArray(json?.events) ? json.events : [])
    .map((e) => ({
      id: String(e.id ?? ''),
      kind: Number(e.kind),
      pubkey: String(e.pubkey ?? ''),
      created_at: Number(e.created_at ?? e.createdAt ?? 0),
      content: String(e.content ?? ''),
      tags: Array.isArray(e.tags) ? (e.tags as string[][]) : [],
      sig: String(e.sig ?? ''),
    }))
    .filter((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === linkPub))
}

/** Receive a bearer coupon into the signer's gateway wallet (`POST /api/v1/wallet/receive`). */
export async function gatewayReceive(endpoints: Endpoints, key: Uint8Array, token: string, fetchImpl: typeof fetch = fetch): Promise<{ token: string } | 'spent' | 'failed'> {
  const path = '/api/v1/wallet/receive'
  const body = JSON.stringify({ token })
  const r = await fetchImpl(`${trim(endpoints.gatewayUrl)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: nip98(key, `${trim(endpoints.publicOrigin ?? endpoints.gatewayUrl)}${path}`, 'POST', body) },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  const answer = (await r.json().catch(() => null)) as { token?: unknown } | null
  if (r.ok && typeof answer?.token === 'string') return { token: answer.token }
  if (/11001|already[\s_]spent|proof already used|already been redeemed/i.test(JSON.stringify(answer ?? {}))) return 'spent'
  return 'failed'
}

export type { CashlinkPorts, KeptCoupon }
