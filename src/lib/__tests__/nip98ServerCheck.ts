import { verifyEvent, type Event } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'

/** One request as it left the client. */
export interface WireRequest {
  url: string
  method: string
  authorization: string | null
  contentType?: string | null
  /** Exactly the bytes sent, '' when there was no body. */
  body: string
}

/**
 * Why imani-security's `Nip98AuthFilter` (0.2.2 and 0.3.0) would refuse this request, or null.
 *
 * A port of the checks that decide the terminal confirm and cancel calls: kind 27235, `u` and
 * `method` match the request, and for every write method (anything but GET, HEAD, OPTIONS) a
 * `payload` tag that is the SHA-256 of the body as received. The event id and signature are
 * verified, as the filter does. Messages are the filter's own, so a refusal reads like the
 * gateway log line.
 */
export function nip98Refusal(req: WireRequest): string | null {
  if (!req.authorization?.startsWith('Nostr ')) return 'NIP-98 authentication required'
  let event: Event
  try {
    event = JSON.parse(atob(req.authorization.slice('Nostr '.length))) as Event
  } catch {
    return 'Malformed authorization'
  }
  if (event.kind !== 27235) return 'Invalid event kind'
  const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1]
  const u = tag('u')
  const method = tag('method')
  if (u === undefined || method === undefined) return 'Missing required tags (u, method)'
  if (u !== req.url) return 'URL mismatch'
  if (method.toUpperCase() !== req.method.toUpperCase()) return 'Method mismatch'

  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())
  if (write) {
    const payload = tag('payload')
    if (!payload || payload.trim() === '') {
      return `NIP-98 payload tag required for ${req.method.toUpperCase()}`
    }
    const actual = bytesToHex(sha256(new TextEncoder().encode(req.body)))
    if (payload !== actual) return 'NIP-98 payload hash mismatch'
  }

  if (!verifyEvent(event)) return 'Invalid signature'
  return null
}
