/**
 * SHA-256 helper for Blossom upload requests.
 *
 * Used to populate the `x` tag on the kind-24242 auth event and the
 * `X-SHA-256` request header per BUD-02 and BUD-11.
 *
 * @blossom-spec BUD-02 § "PUT /upload" (X-SHA-256) + BUD-11 § "Validation" (x tag) — github.com/hzrd149/blossom @ ef3c79e40d38cee6cdc974056ae86a582e708197
 */

import { sha256 } from '@noble/hashes/sha256';

/**
 * Compute the lowercase hex SHA-256 of a byte buffer.
 *
 * Whole-buffer hash via `@noble/hashes/sha256`. For the MVP file-size ceiling
 * of 10 MB, this completes in under 200 ms on the project's low-end Android
 * baseline (research.md § R-006). Streaming-hash variants are not used.
 *
 * @param bytes the bytes to hash
 * @returns lowercase hex (64 chars), e.g. "b1674191a8…f553"
 */
export function computeSha256Hex(bytes: Uint8Array): string {
  const digest = sha256(bytes);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    const byte = digest[i] ?? 0;
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
