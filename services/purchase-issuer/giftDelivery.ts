/**
 * Delivering a gifting-site gift that was MINTED locked (#410 G14, ADR 0016, contract §2/§3).
 *
 * The voucher already exists, locked to the recipient (handle: their pinned key; email: L =
 * getPublicKey(ℓ)) with refund = the buyer's key and locktime x. This module only moves it:
 *
 * - email: publish `wrapForLink(ℓ, token)` (kind 1059, NIP-98 by ℓ), confirm it by querying it
 *   back, send the claim email (`gift-claim`, idempotency `<draftId>:claim`), scrub the seal.
 * - both: hand the buyer the locked token so they can take it back after x. Always a NIP-17 wrap
 *   to the REFUND key, signed by this issuer's own key, rumor `imani_gift_sent`. A signed-in
 *   buyer's refund key is their wallet key (dm-poll reads it). A guest's refund key is R, which only
 *   the guest's return link holds: the wallet's `/gift-return#r=R` page reads wraps to getPublicKey(R)
 *   with R and finds the token there. The issuer never holds R and never puts a token in an email.
 *
 * ℓ is never logged and never leaves this process except inside the claim URL sent to the mailer.
 */
import { finalizeEvent, getPublicKey, nip17 } from 'nostr-tools'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { SendOutcome, SendRequest } from '../imani-mailer/mailer.ts'
import { giftSentRumor, wrapForLink } from './giftLock'
import type { TrackInput } from './giftTracker'
import type { CodeGiftPorts } from './codeGift'

export const NOSTR_EVENTS_PATH = '/api/v1/nostr/events'
export const NOSTR_QUERY_PATH = '/api/v1/nostr/query'

export interface WrapEvent {
  id: string
  kind: number
  pubkey: string
  created_at: number
  content: string
  tags: string[][]
  sig: string
}

/** What gift delivery needs from the outside world. Every method must never throw for an answer. */
export interface GiftPorts {
  /** This issuer's seal key (G4), hex. Opens the sealed ℓ and signs the buyer's wrap. */
  sealSecretHex: string
  /** TEST MODE ONLY: the claim window in seconds (`PURCHASE_TEST_CLAIM_WINDOW_SECONDS`). */
  testWindowSeconds?: number | null
  /** The wallet's public origin, for the claim link. */
  walletOrigin: string
  /** POST a signed event to the gateway relay, NIP-98 by `signer`. True when stored. */
  publishEvent(signer: Uint8Array, event: WrapEvent): Promise<boolean>
  /** Every kind-1059 wrap p-tagged to getPublicKey(reader), read with `reader`'s NIP-98. Throws when unreachable. */
  queryWraps(reader: Uint8Array): Promise<WrapEvent[]>
  /** imani-mailer. */
  sendMail(req: SendRequest): Promise<SendOutcome>
  /** Drop the debt's sealed ℓ (payment-adapter `/purchases/{id}/scrub`). True when done. */
  scrubSeal(eventId: string): Promise<boolean>
  /**
   * The first mint instant recorded for this purchase, recording `nowMs` when there is none. Durable:
   * the locktime is derived from it, and a retry that sent another locktime would send another body
   * under the same warrant nonce and idempotency key (gc 409 WARRANT_ALREADY_USED).
   */
  anchor(eventId: string, nowMs: number): Promise<number>
  /** The stall's display name for the email, or null. */
  stallName(stallPubkey: string): Promise<string | null>
  /** G15 §4.3: record a delivered gift for claimed/expired notices (`giftTracker.ts`). Optional. */
  track?(input: TrackInput, mintUrl: string): Promise<void>
  /** #410 code gifts: the code store. Absent (`PURCHASE_CODE_GIFTS` off), code gifts are parked before minting. */
  codes?: CodeGiftPorts
}

export type StepResult = { ok: true } | { ok: false; reason: string; permanent: boolean }

const ok: StepResult = { ok: true }

/** True when `wrap`, opened with ℓ, carries exactly `token`. */
function carries(wrap: WrapEvent, linkSecret: Uint8Array, token: string): boolean {
  try {
    const rumor = nip17.unwrapEvent(wrap as never, linkSecret)
    const body = JSON.parse(rumor.content) as Record<string, unknown>
    return body.type === 'cashu_token_transfer' && body.token === token
  } catch {
    return false
  }
}

/**
 * Publish the Cashlink wrap for ℓ unless one with this token is already stored (a retry publishes
 * nothing new), then confirm it by reading it back.
 */
export async function publishLinkWrap(ports: GiftPorts, linkSecret: Uint8Array, token: string): Promise<StepResult> {
  let existing: WrapEvent[]
  try {
    existing = await ports.queryWraps(linkSecret)
  } catch {
    return { ok: false, reason: 'the gateway relay could not be queried for the gift wrap', permanent: false }
  }
  if (!existing.some((w) => carries(w, linkSecret, token))) {
    const wrap = wrapForLink(linkSecret, token) as unknown as WrapEvent
    let stored = false
    try {
      stored = await ports.publishEvent(linkSecret, wrap)
    } catch {
      stored = false
    }
    if (!stored) return { ok: false, reason: 'the gateway relay did not store the gift wrap', permanent: false }
    try {
      existing = await ports.queryWraps(linkSecret)
    } catch {
      return { ok: false, reason: 'the gift wrap could not be confirmed (relay query failed)', permanent: false }
    }
    if (!existing.some((w) => carries(w, linkSecret, token))) {
      return { ok: false, reason: 'the gift wrap was accepted but is not readable back', permanent: false }
    }
  }
  return ok
}

/** The claim email, through imani-mailer, under one idempotency key for every retry. */
export async function sendClaimEmail(
  ports: GiftPorts,
  req: { to: string; draftKey: string; fields: Record<string, string> },
): Promise<StepResult> {
  let out: SendOutcome
  try {
    out = await ports.sendMail({ template: 'gift-claim', to: req.to, fields: req.fields, idempotencyKey: `${req.draftKey}:claim` })
  } catch {
    return { ok: false, reason: 'imani-mailer is unreachable', permanent: false }
  }
  if (out.ok) return ok
  // The mailer's message names the field or the policy, never a value (imani-mailer logs nothing secret).
  return { ok: false, reason: `the claim email was refused: ${out.error}`, permanent: !out.retryable }
}

/** The recipient's code email (`gift-code`), under one idempotency key for every retry. */
export async function sendCodeEmail(
  ports: GiftPorts,
  req: { to: string; idempotencyKey: string; fields: Record<string, string> },
): Promise<StepResult> {
  let out: SendOutcome
  try {
    out = await ports.sendMail({ template: 'gift-code', to: req.to, fields: req.fields, idempotencyKey: req.idempotencyKey })
  } catch {
    return { ok: false, reason: 'imani-mailer is unreachable', permanent: false }
  }
  if (out.ok) return ok
  return { ok: false, reason: `the code email was refused: ${out.error}`, permanent: !out.retryable }
}

/** Hand the buyer the locked token (contract §3): a NIP-17 wrap to the refund key. */
export async function handBuyerTheGift(
  ports: GiftPorts,
  input: { refundPubkey: string; token: string; stall: string; to: string | null; claimBy: number; gift?: 'code' },
): Promise<StepResult> {
  const sealKey = hexToBytes(ports.sealSecretHex)
  const wrap = nip17.wrapEvent(sealKey, { publicKey: input.refundPubkey }, giftSentRumor(input)) as unknown as WrapEvent
  let stored = false
  try {
    stored = await ports.publishEvent(sealKey, wrap)
  } catch {
    stored = false
  }
  return stored ? ok : { ok: false, reason: "the buyer's copy of the gift was not stored by the gateway relay", permanent: false }
}

// ─── HTTP adapters ──────────────────────────────────────────────────────────

function nip98(key: Uint8Array, url: string, method: string, body: string): string {
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', url],
        ['method', method],
        ['payload', bytesToHex(sha256(new TextEncoder().encode(body)))],
        ['nonce', bytesToHex(randomBytes(16))],
      ],
      content: '',
    },
    key,
  )
  return `Nostr ${btoa(JSON.stringify(event))}`
}

const trim = (u: string) => u.trim().replace(/\/+$/, '')

/** `publishEvent` against the gateway (as sdk/cashlink-sender's `publishEvent`). */
export function httpPublishEvent(gatewayUrl: string, fetchImpl: typeof fetch = fetch) {
  return async (signer: Uint8Array, event: WrapEvent): Promise<boolean> => {
    const url = `${trim(gatewayUrl)}${NOSTR_EVENTS_PATH}`
    const body = JSON.stringify({
      id: event.id,
      pubkey: event.pubkey,
      createdAt: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    })
    try {
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: nip98(signer, url, 'POST', body) },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      })
      return r.ok
    } catch {
      return false
    }
  }
}

/** `queryWraps` against the gateway (as sdk/cashlink-sender's `queryWraps`). */
export function httpQueryWraps(gatewayUrl: string, fetchImpl: typeof fetch = fetch) {
  return async (reader: Uint8Array): Promise<WrapEvent[]> => {
    const pub = getPublicKey(reader)
    const url = `${trim(gatewayUrl)}${NOSTR_QUERY_PATH}`
    const body = JSON.stringify({ kinds: [1059], pTags: [pub], limit: 50 })
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: nip98(reader, url, 'POST', body) },
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
      .filter((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === pub))
  }
}

/** The stall's kind-0 name, best effort. */
export function httpStallName(gatewayUrl: string, fetchImpl: typeof fetch = fetch) {
  return async (stallPubkey: string): Promise<string | null> => {
    try {
      const r = await fetchImpl(`${trim(gatewayUrl)}${NOSTR_QUERY_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kinds: [0], authors: [stallPubkey.toLowerCase()], limit: 5 }),
        signal: AbortSignal.timeout(5_000),
      })
      if (!r.ok) return null
      const json = (await r.json()) as { events?: Array<Record<string, unknown>> }
      const newest = (json.events ?? [])
        .filter((e) => e.pubkey === stallPubkey.toLowerCase() && e.kind === 0)
        .sort((a, b) => Number(b.created_at ?? b.createdAt ?? 0) - Number(a.created_at ?? a.createdAt ?? 0))[0]
      if (!newest) return null
      const meta = JSON.parse(String(newest.content ?? '{}')) as Record<string, unknown>
      const name = typeof meta.name === 'string' ? meta.name : typeof meta.display_name === 'string' ? meta.display_name : null
      return name && name.trim() ? name.trim().slice(0, 120) : null
    } catch {
      return null
    }
  }
}

/**
 * The durable mint anchors, one small JSON file (`{eventId: ms}`). Written atomically before the
 * first mint of a gift, so every retry, across restarts, sends the same locktime.
 */
export function fileAnchors(path: string) {
  let chain: Promise<unknown> = Promise.resolve()
  return (eventId: string, nowMs: number): Promise<number> => {
    const run = chain.then(async () => {
      let map: Record<string, number> = {}
      try {
        map = JSON.parse(await readFile(path, 'utf8')) as Record<string, number>
      } catch (error) {
        // Missing is empty; corrupt THROWS (an anchor forgotten is a locktime changed).
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const found = map[eventId]
      if (typeof found === 'number') return found
      map[eventId] = nowMs
      await mkdir(dirname(path), { recursive: true })
      await writeFile(`${path}.tmp`, JSON.stringify(map), { mode: 0o600 })
      await rename(`${path}.tmp`, path)
      return nowMs
    })
    chain = run.catch(() => undefined)
    return run
  }
}

/**
 * Business metrics: payment-adapter's `POST /api/v1/purchases/gifts/{draftId}/outcome`, so the one
 * owner of gift states learns what the recipient did. 2xx is delivered; 400, 404 and 409 will never
 * be accepted (`gone`); anything else, or no answer, is retried on the next sweep.
 */
export function httpReportOutcome(purchasesUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
  return async (draftId: string, outcome: string, remainingMinor?: number): Promise<'ok' | 'gone' | 'retry'> => {
    try {
      const r = await fetchImpl(`${trim(purchasesUrl)}/api/v1/purchases/gifts/${encodeURIComponent(draftId)}/outcome`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ outcome, ...(remainingMinor !== undefined ? { remainingMinor } : {}) }),
        signal: AbortSignal.timeout(10_000),
      })
      if (r.ok) return 'ok'
      return r.status === 400 || r.status === 404 || r.status === 409 ? 'gone' : 'retry'
    } catch {
      return 'retry'
    }
  }
}

/** Payment-adapter's scrub (`POST /api/v1/purchases/{eventId}/scrub`). */
export function httpScrub(purchasesUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
  return async (eventId: string): Promise<boolean> => {
    try {
      const r = await fetchImpl(`${trim(purchasesUrl)}/api/v1/purchases/${encodeURIComponent(eventId)}/scrub`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      return r.ok
    } catch {
      return false
    }
  }
}
