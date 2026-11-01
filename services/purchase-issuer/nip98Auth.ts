/**
 * Who is calling: a NIP-98 signature, checked (imani-wallet#298).
 *
 * The enrolment endpoint is called by the STALL, from the merchant's phone, and the only proof
 * of who that is is a NIP-98 event signed with the stall's own key. The key itself never comes
 * here (owner requirement, 2026-10-18: the merchant's key never leaves their phone). This takes
 * a request and returns a pubkey or a reason, nothing else.
 *
 * A port of `services/wallet-api/nip98.ts`, not an import: this image may not reach outside its
 * own tree (the Dockerfile asserts it). The id and BIP-340 signature are checked with
 * nostr-tools' `verifyEvent`, which this service already uses for delegations.
 *
 * ## Replay
 *
 * A signature is accepted ONCE (`ReplayGuard`). Enrolment replaces a stall's credential, so a
 * captured request replayed inside the freshness window must not be able to swap it back.
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { verifyEvent, type Event } from 'nostr-tools/pure'

export const NIP98_KIND = 27235

/** Seconds a signature may be from now, either way. The same window as wallet-api. */
export const FRESHNESS_WINDOW_SECONDS = 60

export type AuthResult =
  | { ok: true; pubkey: string; eventId: string }
  | { ok: false; reason: string }

export interface Nip98Request {
  header: string | undefined
  /** The absolute URL the caller signed for: the public origin plus the request path. */
  url: string
  method: string
  /** The raw body, '' when there was none. */
  body: string
  /** Seconds since the epoch. */
  now?: number
}

export function verifyNip98({ header, url, method, body, now = Math.floor(Date.now() / 1000) }: Nip98Request): AuthResult {
  const refuse = (reason: string): AuthResult => ({ ok: false, reason })
  if (!header) return refuse('unsigned: send Authorization: Nostr <base64 event>')
  const match = /^Nostr\s+(.+)$/i.exec(header.trim())
  if (!match) return refuse('malformed: not a Nostr authorization')

  let event: Event
  try {
    event = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as Event
  } catch {
    return refuse('malformed: not base64 JSON')
  }
  if (
    !event ||
    typeof event.pubkey !== 'string' ||
    typeof event.id !== 'string' ||
    typeof event.sig !== 'string' ||
    typeof event.created_at !== 'number' ||
    !Array.isArray(event.tags)
  ) {
    return refuse('malformed: not a signed event')
  }
  if (event.kind !== NIP98_KIND) return refuse(`malformed: expected kind ${NIP98_KIND}`)
  if (Math.abs(now - event.created_at) > FRESHNESS_WINDOW_SECONDS) {
    return refuse('stale: check the clock on the calling device')
  }

  let signed = false
  try {
    // A copy, so a verdict cached on the object by nostr-tools cannot vouch for it.
    signed = verifyEvent({ ...event })
  } catch {
    signed = false
  }
  if (!signed) return refuse('bad-signature')

  const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1]
  if (!sameUrl(tag('u'), url)) return refuse('url-mismatch')
  if ((tag('method') ?? '').toUpperCase() !== method.toUpperCase()) return refuse('method-mismatch')
  // Required once there is a body: otherwise a signature over one body could carry another.
  if (body.length > 0) {
    const payload = tag('payload')
    if (!payload || payload.toLowerCase() !== bytesToHex(sha256(utf8ToBytes(body)))) {
      return refuse('payload-mismatch')
    }
  }
  return { ok: true, pubkey: event.pubkey.toLowerCase(), eventId: event.id.toLowerCase() }
}

function sameUrl(signed: string | undefined, actual: string): boolean {
  if (!signed) return false
  try {
    const a = new URL(signed)
    const b = new URL(actual)
    return (
      a.protocol === b.protocol &&
      a.host.toLowerCase() === b.host.toLowerCase() &&
      a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '') &&
      a.search === b.search
    )
  } catch {
    return false
  }
}

/**
 * Event ids seen inside the freshness window. Remembered for twice the window, which covers a
 * signature from either edge of it, and no longer.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>()
  private readonly cap: number

  constructor(cap = 10_000) {
    this.cap = cap
  }

  /** True the first time an id is offered, false after. */
  accept(eventId: string, nowMs: number = Date.now()): boolean {
    for (const [id, until] of this.seen) {
      if (until <= nowMs) this.seen.delete(id)
    }
    if (this.seen.has(eventId)) return false
    // Full of live entries: refuse rather than forget one, so a flood cannot evict a real id.
    if (this.seen.size >= this.cap) return false
    this.seen.set(eventId, nowMs + 2 * FRESHNESS_WINDOW_SECONDS * 1000)
    return true
  }
}
