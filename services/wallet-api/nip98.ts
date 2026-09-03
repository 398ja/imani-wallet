import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

/**
 * Verifying a NIP-98 request signature.
 *
 * The wallet already SIGNS these (`src/lib/nip98.ts`). Nothing has ever had to
 * check one, because the gateway did it in Java. This is the other half, and it
 * is the whole security boundary of the wallet API: a caller proves who it is
 * per request, and the service holds no session that could be stolen instead.
 *
 * ## Why the refusals are separate
 *
 * Each of these is a different fix on the caller's side:
 *
 * - unsigned — you did not send the header
 * - malformed — you sent something that is not a signed event
 * - bad signature — you signed, but not with the key you claim
 * - stale — your clock is wrong, or you replayed an old request
 * - wrong URL, method, or body — you signed a different request than you sent
 *
 * A service that answers "unauthorized" to all five leaves the caller guessing,
 * and the guess most people make is "the key is wrong" — which sends them
 * rotating credentials over a clock skew.
 *
 * ## What this deliberately does not do
 *
 * It does not sign, and it never sees a private key. It takes a request and
 * returns a pubkey or a reason, which is the entire contract.
 */

/** NIP-98's kind for an HTTP auth event. */
export const NIP98_KIND = 27235

/**
 * How far a signature's timestamp may be from now.
 *
 * 60 seconds each way. Tight enough that a captured header is useless almost
 * immediately, loose enough to survive the clock drift of a phone that has not
 * synced today — which is the caller this has to work for.
 *
 * Both directions, because a clock AHEAD of the server is exactly as common as
 * one behind, and refusing only the past would accept a header signed for
 * tomorrow.
 */
export const FRESHNESS_WINDOW_SECONDS = 60

/** Why a request was refused. One per fix the caller would make. */
export type AuthFailure =
  | 'unsigned'
  | 'malformed'
  | 'bad-signature'
  | 'stale'
  | 'url-mismatch'
  | 'method-mismatch'
  | 'payload-mismatch'

export type AuthResult =
  // The event id comes back so the caller can refuse a replay. It is unique
  // per signature and already verified to match the event's contents, which is
  // exactly what a replay store needs as a key.
  | { ok: true; pubkey: string; eventId: string }
  | { ok: false; reason: AuthFailure; detail: string }

/** The signed event NIP-98 carries, as it arrives on the wire. */
interface AuthEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface VerifyOptions {
  /** The `Authorization` header, exactly as received. */
  header: string | undefined
  /** The absolute URL the request arrived at. */
  url: string
  /** The HTTP method. */
  method: string
  /** The raw body, or undefined when there was none. */
  body?: string
  /** Seconds since the epoch. Injectable so freshness is testable. */
  now?: number
}

export function verifyNip98({
  header,
  url,
  method,
  body,
  now = Math.floor(Date.now() / 1000),
}: VerifyOptions): AuthResult {
  if (!header) {
    return {
      ok: false,
      reason: 'unsigned',
      detail: 'no Authorization header. Sign the request: Authorization: Nostr <base64 event>',
    }
  }

  const match = /^Nostr\s+(.+)$/i.exec(header.trim())
  if (!match) {
    return {
      ok: false,
      reason: 'malformed',
      detail: 'Authorization header is not a Nostr scheme. Expected: Nostr <base64 event>',
    }
  }

  let event: AuthEvent
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8')
    event = JSON.parse(decoded) as AuthEvent
  } catch {
    return { ok: false, reason: 'malformed', detail: 'the credential is not base64-encoded JSON' }
  }

  if (
    typeof event?.pubkey !== 'string' ||
    typeof event?.sig !== 'string' ||
    typeof event?.id !== 'string' ||
    typeof event?.created_at !== 'number' ||
    !Array.isArray(event?.tags)
  ) {
    return { ok: false, reason: 'malformed', detail: 'the credential is not a signed nostr event' }
  }

  if (event.kind !== NIP98_KIND) {
    return {
      ok: false,
      reason: 'malformed',
      detail: `expected a kind ${NIP98_KIND} event, got ${event.kind}`,
    }
  }

  // Freshness BEFORE the signature, and that ordering is deliberate: a stale
  // header is the common honest mistake, and checking it first means a caller
  // with a wrong clock is told about the clock rather than about their key.
  // Verification is also the expensive step, so this refuses replay floods
  // without paying for the curve.
  const age = now - event.created_at
  if (Math.abs(age) > FRESHNESS_WINDOW_SECONDS) {
    return {
      ok: false,
      reason: 'stale',
      detail:
        `signature is ${Math.abs(age)}s ${age > 0 ? 'old' : 'in the future'}, ` +
        `outside the ${FRESHNESS_WINDOW_SECONDS}s window. Check the clock on the calling machine.`,
    }
  }

  // The id is a hash of the event's own fields, so an id that does not match
  // means the event was edited after signing. Checked before the signature
  // because schnorr verifies against the id: a forged id with a valid
  // signature over IT would otherwise pass while the content had changed.
  if (serialisedId(event) !== event.id.toLowerCase()) {
    return {
      ok: false,
      reason: 'bad-signature',
      detail: 'the event id does not match its contents, so it was altered after signing',
    }
  }

  let signatureValid = false
  try {
    // @noble/curves v2 takes BYTES, not hex, and throws on a bad length rather
    // than returning false. The lengths are checked explicitly first, the way
    // `src/lib/voucherToken.ts` does, so a truncated key is a clean refusal
    // rather than an exception that would surface as a 500 — an unauthenticated
    // caller must never be able to make this service throw.
    const sig = hexToBytes(event.sig.toLowerCase())
    const pub = hexToBytes(event.pubkey.toLowerCase())
    const id = hexToBytes(event.id.toLowerCase())
    signatureValid =
      sig.length === 64 &&
      pub.length === 32 &&
      id.length === 32 &&
      schnorr.verify(sig, id, pub)
  } catch {
    signatureValid = false
  }
  if (!signatureValid) {
    return {
      ok: false,
      reason: 'bad-signature',
      detail: 'the signature does not verify against the pubkey it claims',
    }
  }

  // Only now are the tags trustworthy: everything below is a claim the caller
  // signed, so comparing before verification would be comparing against text
  // anyone could have written.
  const tag = (name: string): string | undefined =>
    event.tags.find((t) => t[0] === name)?.[1]

  const signedUrl = tag('u')
  if (!signedUrl || !sameUrl(signedUrl, url)) {
    return {
      ok: false,
      reason: 'url-mismatch',
      detail: `signed for ${signedUrl ?? '(no u tag)'} but sent to ${url}`,
    }
  }

  const signedMethod = tag('method')
  if (!signedMethod || signedMethod.toUpperCase() !== method.toUpperCase()) {
    return {
      ok: false,
      reason: 'method-mismatch',
      detail: `signed for ${signedMethod ?? '(no method tag)'} but sent as ${method.toUpperCase()}`,
    }
  }

  // The payload tag is REQUIRED once there is a body, and that is the whole
  // point of it: without this check a valid signature over an empty request
  // could be replayed against any body at all.
  const signedPayload = tag('payload')
  if (body !== undefined && body.length > 0) {
    const actual = bytesToHex(sha256(utf8ToBytes(body)))
    if (!signedPayload) {
      return {
        ok: false,
        reason: 'payload-mismatch',
        detail: 'the request has a body but the signature has no payload tag',
      }
    }
    if (signedPayload.toLowerCase() !== actual) {
      return {
        ok: false,
        reason: 'payload-mismatch',
        detail: 'the body does not match the payload hash that was signed',
      }
    }
  }

  return { ok: true, pubkey: event.pubkey.toLowerCase(), eventId: event.id.toLowerCase() }
}

/**
 * NIP-01's event id: sha256 over a canonical array.
 *
 * The field ORDER is part of the protocol, not a preference — a different
 * order hashes differently and every signature in the world would fail.
 */
function serialisedId(event: AuthEvent): string {
  const canonical = JSON.stringify([
    0,
    event.pubkey.toLowerCase(),
    event.created_at,
    event.kind,
    event.tags,
    event.content ?? '',
  ])
  return bytesToHex(sha256(utf8ToBytes(canonical)))
}

/**
 * Are these the same URL for signing purposes?
 *
 * Compared field by field rather than as strings, because a proxy can rewrite a
 * URL without changing where the request went: a trailing slash, a different
 * case in the host, an explicit `:443` on https. Each of those would fail a
 * string comparison and none of them means the caller signed a different
 * request.
 *
 * The query string IS compared. It carries arguments, and a signature that did
 * not cover them would let anyone replay a signed request against different
 * parameters.
 */
function sameUrl(signed: string, actual: string): boolean {
  try {
    const a = new URL(signed)
    const b = new URL(actual)
    return (
      a.protocol === b.protocol &&
      a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
      a.port === b.port &&
      a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '') &&
      a.search === b.search
    )
  } catch {
    return false
  }
}
