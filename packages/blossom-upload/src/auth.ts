/**
 * Blossom kind-24242 authorization event construction + Authorization header encoding.
 *
 * The host's `SignFn` callback produces the `id` and `sig` fields; this module
 * builds everything else (kind, created_at, tags, content, pubkey) and encodes
 * the signed event into the `Authorization: Nostr <base64>` header value.
 *
 * @blossom-spec BUD-11 § "Authorization tokens" + § "HTTP Authorization Header" — github.com/hzrd149/blossom @ ef3c79e40d38cee6cdc974056ae86a582e708197
 */

import type { UnsignedAuthEvent, SignedAuthEvent } from './types';

/** Verb values per BUD-11 § "Endpoint Authorization Requirements". */
export type AuthVerb = 'upload' | 'media';

/** Default expiration window in seconds: 5 minutes (research.md § R-002). */
export const DEFAULT_EXPIRATION_WINDOW_SECONDS = 300;

/**
 * Build the unsigned kind-24242 event a Blossom upload requires.
 *
 * Tags emitted: `["t", verb]`, `["x", sha256Hex]`, `["expiration", now+300]`.
 * Content: `"Upload Blob"` for `t=upload`, `"Upload optimized media"` for `t=media`.
 *
 * @blossom-spec BUD-11 § "Authorization tokens" — github.com/hzrd149/blossom @ ef3c79e40d38cee6cdc974056ae86a582e708197
 */
export function buildUnsignedAuthEvent(input: {
  pubkey: string;
  verb: AuthVerb;
  sha256Hex: string;
  /** Override Date.now() for deterministic tests. Seconds, not ms. */
  nowSeconds?: number;
}): UnsignedAuthEvent {
  const nowSec = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tags: ReadonlyArray<readonly [string, string]> = [
    ['t', input.verb],
    ['x', input.sha256Hex],
    ['expiration', String(nowSec + DEFAULT_EXPIRATION_WINDOW_SECONDS)],
  ];
  const content = input.verb === 'media' ? 'Upload optimized media' : 'Upload Blob';
  return {
    kind: 24242,
    created_at: nowSec,
    tags,
    content,
    pubkey: input.pubkey,
  };
}

/**
 * Encode a signed kind-24242 event as the `Authorization: Nostr <…>` header value.
 *
 * Format per BUD-01 § "HTTP Authorization Header": **standard** RFC 4648 § 4
 * base64 (with `+` / `/` / `=` padding). NOT base64url. Verified against
 * the production Blossom server 2026-05-30 — URL-safe yields
 * `400 "invalid base64 for auth event"`.
 *
 * JSON field order is stable for testability: id, pubkey, created_at, kind,
 * tags, content, sig.
 */
export function encodeAuthorizationHeader(signed: SignedAuthEvent): string {
  validateSignedEvent(signed);
  const ordered = {
    id: signed.id,
    pubkey: signed.pubkey,
    created_at: signed.created_at,
    kind: signed.kind,
    tags: signed.tags,
    content: signed.content,
    sig: signed.sig,
  };
  const json = JSON.stringify(ordered);
  const b64 = base64Encode(new TextEncoder().encode(json));
  return `Nostr ${b64}`;
}

/**
 * Superficial validation of a SignedAuthEvent returned by the host's SignFn.
 * Throws TypeError with a descriptive message on shape errors — the caller
 * (upload.ts) maps the throw to BlossomUploadError.INTERNAL.
 */
function validateSignedEvent(signed: SignedAuthEvent): void {
  if (typeof signed.id !== 'string' || !/^[0-9a-f]{64}$/.test(signed.id)) {
    throw new TypeError('SignFn returned an event with invalid id (must be 64 lowercase hex chars)');
  }
  if (typeof signed.sig !== 'string' || !/^[0-9a-f]{128}$/.test(signed.sig)) {
    throw new TypeError('SignFn returned an event with invalid sig (must be 128 lowercase hex chars)');
  }
  if (signed.kind !== 24242) {
    throw new TypeError('SignFn mutated kind away from 24242');
  }
}

/**
 * Standard base64 encoding (RFC 4648 § 4, with `+` / `/` / `=` padding).
 *
 * BUD-01 specifies "base64" without qualification; the hzrd149 reference
 * server (and the production Blossom server, verified 2026-05-30) require
 * the standard alphabet. URL-safe (`-`/`_`, no padding) is rejected with
 * `400 "invalid base64 for auth event"`.
 *
 * Doesn't depend on Node's Buffer (so the package works unmodified in
 * browsers and in vitest's node environment).
 */
export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return globalThis.btoa(binary);
}
