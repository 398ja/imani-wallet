/**
 * token_id derivation — spec 017's content-derived primary key.
 *
 * Computes `sha256(canonicalized_token).substring(0, 32)`. Canonicalization
 * matches shared/tokenIdentity.js:
 *   1. If the token starts with `cashu:`, strip the prefix.
 *   2. UTF-8 encode the result.
 *
 * Uses `crypto.subtle.digest`, available in:
 *   - All evergreen browsers
 *   - Node 16+
 *   - Service worker contexts
 *
 * Async because crypto.subtle is async (no sync alternative in browsers).
 */

import { WalletStorageInvalidTokenError } from './errors';

/**
 * Lightweight cashu V3/V4 token shape check — mirrors
 * `shared/storage.js::looksLikeCashuToken`.
 *
 * Returns `true` for inputs that match `/^cashu[A-Z]/` (optionally
 * preceded by `cashu:`), are at least 22 chars after the prefix strip,
 * and contain no whitespace or control characters.
 *
 * Returns plain `boolean` (not a type predicate) so the failure branch
 * keeps the input's original type for follow-up reporting.
 */
export function looksLikeCashuToken(token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const stripped = token.startsWith('cashu:') ? token.slice(6) : token;
  if (stripped !== stripped.trim()) return false;
  if (/\s/.test(stripped)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(stripped)) return false;
  if (!/^cashu[A-Z]/.test(stripped)) return false;
  return stripped.length >= 22;
}

/**
 * Derive the spec-017 content-derived `token_id` from a cashu token.
 * Throws {@link WalletStorageInvalidTokenError} if the token doesn't
 * pass the shape check.
 */
export async function tokenIdFrom(token: unknown): Promise<string> {
  if (!looksLikeCashuToken(token)) {
    throw new WalletStorageInvalidTokenError(
      'tokenIdFrom: input failed cashu shape check',
      {
        token_length: typeof token === 'string' ? token.length : 0,
        token_prefix: safeTokenPrefix(token),
        source: 'tokenId_compute_failed',
      }
    );
  }
  // After the guard, we know token is a non-empty cashu-shaped string.
  const str = token as string;
  const canonical = str.startsWith('cashu:') ? str.slice(6) : str;
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bufToHex(digest).slice(0, 32);
}

/** Same surface as the helper of the same name in shared/storage.js. */
export function safeTokenPrefix(token: unknown): string {
  if (typeof token !== 'string') return '<non-string>';
  return token.slice(0, 8);
}

function bufToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    const byte = view[i]!;
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}
