/**
 * The one relay size budget every event builder shares (#532).
 *
 * strfry refuses an event over `maxEventSize`, 65,536 bytes on staging and in the prod image
 * (`invalid: event too large: N`). A NIP-17 gift wrap applies NIP-44 twice (rumor into seal, seal
 * into wrap), and NIP-44 pads to buckets, so the wrap grows in steps. The step that matters is the
 * rumor crossing {@link RUMOR_KNEE_BYTES} (7 x 4096): up to there the wrap is at most 55,121 bytes,
 * one byte more and it is 66,045 bytes, which strfry refuses.
 *
 * This is gateway-customer's `GiftWrapSizeModel`, ported. `wrapSize.test.ts` checks it against the
 * real `nip17.wrapEvent` byte for byte.
 *
 * Imports nothing: the purchase-issuer image copies this file on its own.
 *
 * <pre>
 *   pad(L)    = NIP-44 v2 calc_padded_len
 *   nip44(L)  = 4 * ceil((pad(L) + 67) / 3)       version 1 + nonce 32 + length 2 + pad + mac 32, base64
 *   rumor     = 278 + escaped(content)            id, pubkey, created_at, kind 14, ["p", recipient]
 *   seal      = 343 + nip44(rumor)                id, pubkey, created_at, kind 13, no tags, sig
 *   wrap      = 417 + nip44(seal)                 id, pubkey, created_at, kind 1059, ["p", recipient], sig
 * </pre>
 */

/** strfry's default `maxEventSize`, what staging and the prod relay image run. */
export const RELAY_MAX_EVENT_BYTES = 65_536

/**
 * The largest event any builder publishes: the top NIP-44 bucket under the cliff. About 10 KB of
 * headroom below {@link RELAY_MAX_EVENT_BYTES}, for a relay configured slightly lower.
 */
export const WRAP_BUDGET_BYTES = 55_121

/** The rumor size (escaped JSON bytes) above which a wrap jumps from 55,121 to 66,045 bytes. */
export const RUMOR_KNEE_BYTES = 28_672

/** Rumor JSON around its content: id, pubkey, created_at (10 digits), kind 14, one p tag. */
export const RUMOR_FIXED_BYTES = 278
/** Seal JSON around its content: id, pubkey, created_at, kind 13, empty tags, sig. */
export const SEAL_FIXED_BYTES = 343
/** Wrap JSON around its content: id, pubkey, created_at, kind 1059, one p tag, sig. */
export const WRAP_FIXED_BYTES = 417

/** The most escaped content one NIP-17 wrap holds and stays within {@link WRAP_BUDGET_BYTES}. */
export const WRAP_CONTENT_MAX_BYTES = RUMOR_KNEE_BYTES - RUMOR_FIXED_BYTES

/** A builder asked to make an event the relay would refuse. Permanent: a retry builds the same. */
export class OversizeEventError extends Error {
  readonly bytes: number
  readonly budget: number
  constructor(bytes: number, budget: number, what = 'event') {
    super(`${what} would be ${bytes} bytes, over the ${budget}-byte relay budget`)
    this.name = 'OversizeEventError'
    this.bytes = bytes
    this.budget = budget
  }
}

/** NIP-44 v2 `calc_padded_len`. */
export function nip44PaddedLength(len: number): number {
  if (len <= 32) return 32
  const nextPower = 2 ** (Math.floor(Math.log2(len - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((len - 1) / chunk) + 1)
}

/** Base64 characters of a NIP-44 v2 payload for `plaintextBytes` of plaintext (16-bit prefix). */
export function nip44PayloadChars(plaintextBytes: number): number {
  return 4 * Math.ceil((nip44PaddedLength(plaintextBytes) + 67) / 3)
}

/** UTF-8 bytes of `content` as it sits inside the rumor's JSON (escaping counted, quotes not). */
export function escapedUtf8Bytes(content: string): number {
  return new TextEncoder().encode(JSON.stringify(content)).length - 2
}

/** Bytes of the kind-1059 event a NIP-17 wrap of a rumor with this content becomes. */
export function wrapEventBytes(content: string): number {
  return wrapEventBytesForRumor(RUMOR_FIXED_BYTES + escapedUtf8Bytes(content))
}

/** Bytes of the kind-1059 event for a rumor of `rumorBytes` of JSON. */
export function wrapEventBytesForRumor(rumorBytes: number): number {
  return WRAP_FIXED_BYTES + nip44PayloadChars(SEAL_FIXED_BYTES + nip44PayloadChars(rumorBytes))
}

/** True when a NIP-17 wrap of this rumor content fits {@link WRAP_BUDGET_BYTES}. */
export function fitsOneWrap(content: string, budget = WRAP_BUDGET_BYTES): boolean {
  return wrapEventBytes(content) <= budget
}

/** Bytes of an event as it goes on the wire. */
export function eventBytes(event: unknown): number {
  return new TextEncoder().encode(JSON.stringify(event)).length
}
