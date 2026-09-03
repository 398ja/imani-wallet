import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'

import { getSigner } from './nap'

/**
 * NIP-98 HTTP authentication headers.
 *
 * The NAP session cookie authenticates the *session*; NIP-98 authenticates an
 * individual *request* with a signature. The gateway wants the second for its
 * write endpoints — `POST /api/v1/nip05` is behind `Nip98AuthFilter`, and an
 * unsigned request comes back 401 `nip98_auth_required`, never 403, so a missing
 * header reads as "not logged in" rather than "not signed".
 *
 * The wallet already produces NIP-98 elsewhere, but only inside the legacy
 * vanilla-JS bridge (`legacyBridge.ts` hands imani-apps' `shared/api.js` a raw
 * privkey). This is the same protocol done through nap's signer, so the key is
 * never copied out and a locked wallet fails loudly instead of signing.
 *
 * Shape follows imani-apps' own implementation
 * (`packages/sw-notifications/src/crypto/nip98.ts`): a kind-27235 event whose
 * `u` and `method` tags bind the signature to one URL and verb. Copied rather
 * than imported — that package is a service-worker bundle, and aliasing all of
 * it for fifteen lines costs more than it saves.
 */

/**
 * The absolute URL the gateway will reconstruct for this request.
 *
 * It compares the `u` tag against the URL it rebuilds from the Host header, so
 * this must be the browser's own origin — which is why the Vite proxy rules for
 * NIP-98 endpoints set `changeOrigin: false`. Rewriting Host makes every signed
 * call fail with `AUTH_002 URL mismatch`, a credential-shaped error caused by
 * proxy configuration.
 */
function absolute(path: string): string {
  return new URL(path, window.location.origin).toString()
}

/** Just enough of a signer to authenticate a request. */
export interface RequestSigner {
  signEvent(template: {
    kind: number
    created_at: number
    tags: string[][]
    content: string
  }): Promise<SignedEvent>
}

/**
 * The COMPLETE signed event, because the whole thing goes on the wire.
 *
 * This used to be declared as `{ id; sig; pubkey }`, which was a quiet lie:
 * `nip98Header` serialises whatever it gets back, and a verifier re-derives the
 * id by hashing `kind`, `created_at`, `tags` and `content`. A signer that
 * returned only the three declared fields would produce a header that NO
 * correct verifier could accept, and the type said that was fine.
 *
 * Nothing was broken in production — every real signer here is nostr-tools'
 * `finalizeEvent`, which returns the full event — so this was latent rather
 * than live. It stopped being latent the moment a test wrote a signer to the
 * declared type and produced headers the verifier rejected as malformed.
 */
export interface SignedEvent {
  id: string
  pubkey: string
  sig: string
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

/**
 * `Authorization` header value for one request.
 *
 * @param path  same-origin path, e.g. `/api/v1/nip05`
 * @param method HTTP verb, upper case
 * @param body  the exact serialised body being sent, if any. Must be the same
 *              string handed to `fetch` — the `payload` tag is its hash, so a
 *              re-serialisation with different key order fails verification.
 * @param signer defaults to the session signer. Registration passes its own,
 *              because it signs the handle claim BEFORE there is a session —
 *              NIP-98 authenticates the request by signature alone and needs no
 *              cookie, which is what lets the login be the last step rather
 *              than the first.
 */
export async function nip98Header(
  path: string,
  method: string,
  body?: string,
  signer: RequestSigner = getSigner(),
): Promise<string> {
  const tags: string[][] = [
    ['u', absolute(path)],
    ['method', method.toUpperCase()],
  ]

  if (body !== undefined) {
    tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  }

  // A nonce, because NIP-98 has no other source of uniqueness.
  //
  // `created_at` is in SECONDS, and the tags are otherwise a pure function of
  // the request. So two identical requests in the same second produce a
  // byte-identical event with an identical id — measured, not theorised — and
  // a server doing replay protection cannot tell them from a captured request
  // resent. It must refuse one, and refusing an honest second request is worse
  // than the alternative.
  //
  // The nonce makes each signature unique, so the server can refuse duplicates
  // safely. The spec allows extra tags and requires servers to check only `u`,
  // `method` and `created_at`, so this stays interoperable: a server that
  // ignores the tag is unaffected.
  //
  // Random rather than a counter: a counter would need state across calls, and
  // resets to zero on every page load, which is exactly when a signer is most
  // likely to repeat itself.
  tags.push(['nonce', bytesToHex(randomBytes(16))])

  const event = await signer.signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  })

  // btoa is byte-oriented and the event JSON is ASCII (hex, base64 and escaped
  // unicode), so no UTF-8 pre-encoding is needed here.
  return `Nostr ${btoa(JSON.stringify(event))}`
}

/**
 * `fetch` with a NIP-98 signature over the body.
 *
 * Serialises once and signs that exact string, which is the only way the
 * `payload` hash can be trusted to match what the server receives.
 */
export async function signedFetch(
  path: string,
  method: string,
  payload?: unknown,
  signer?: RequestSigner,
): Promise<Response> {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const headers: Record<string, string> = {
    Authorization: await nip98Header(path, method, body, signer ?? getSigner()),
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  return fetch(path, { method, headers, body, credentials: 'include' })
}
