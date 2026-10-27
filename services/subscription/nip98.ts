/**
 * Who is calling: a NIP-98 signature over this exact request, from the stall's own key.
 *
 * A port of `services/purchase-issuer/nip98Auth.ts` (each image keeps its own tree). Login to
 * subscription.imani.casa IS this: no account, no password, no session table. Every request the
 * browser makes is signed by the stall key (NIP-07 extension, or a pasted bunker), so the service
 * only ever learns a pubkey (#407 §6).
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { verifyEvent, type Event } from 'nostr-tools/pure'

export const NIP98_KIND = 27235
export const FRESHNESS_WINDOW_SECONDS = 60

export type AuthResult = { ok: true; pubkey: string; eventId: string } | { ok: false; reason: string }

export function verifyNip98(req: {
  header: string | undefined
  url: string
  method: string
  body: string
  now?: number
}): AuthResult {
  const now = req.now ?? Math.floor(Date.now() / 1000)
  const refuse = (reason: string): AuthResult => ({ ok: false, reason })
  const match = /^Nostr\s+(.+)$/i.exec((req.header ?? '').trim())
  if (!match) return refuse('unsigned')
  let event: Event
  try {
    event = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as Event
  } catch {
    return refuse('malformed')
  }
  if (!event || typeof event.pubkey !== 'string' || !Array.isArray(event.tags) || event.kind !== NIP98_KIND) {
    return refuse('malformed')
  }
  if (typeof event.created_at !== 'number' || Math.abs(now - event.created_at) > FRESHNESS_WINDOW_SECONDS) {
    return refuse('stale')
  }
  let signed = false
  try {
    signed = verifyEvent({ ...event })
  } catch {
    signed = false
  }
  if (!signed) return refuse('bad-signature')
  const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1]
  if (!sameUrl(tag('u'), req.url)) return refuse('url-mismatch')
  if ((tag('method') ?? '').toUpperCase() !== req.method.toUpperCase()) return refuse('method-mismatch')
  if (req.body.length > 0) {
    const payload = tag('payload')
    if (!payload || payload.toLowerCase() !== bytesToHex(sha256(utf8ToBytes(req.body)))) return refuse('payload-mismatch')
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

/** A signature is accepted once: a captured checkout or grant request cannot be replayed. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>()
  accept(eventId: string, nowMs = Date.now()): boolean {
    for (const [id, until] of this.seen) if (until <= nowMs) this.seen.delete(id)
    if (this.seen.has(eventId) || this.seen.size >= 10_000) return false
    this.seen.set(eventId, nowMs + 2 * FRESHNESS_WINDOW_SECONDS * 1000)
    return true
  }
}
