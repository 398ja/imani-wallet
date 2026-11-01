/**
 * A real stall, a real delegate key and the stall's real delegation, for tests.
 *
 * Since #152 this service mints nothing without a delegation the till will
 * accept, so a fixture with a made-up stall pubkey (`'b'.repeat(64)`) and no
 * delegation now blocks before minting, which is correct. Tests that exercise
 * minting use these instead: genuine keys, a genuinely signed delegation.
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'

/** The stall's own key. Lives on the stall's phone, never on this service. */
export const STALL_SK = '7'.repeat(63) + '1'
export const STALL = getPublicKey(hexToBytes(STALL_SK))

/** The credential's lock key, which this service holds per stall. */
export const LOCK = '11'.repeat(32)
export const LOCK_PUB = getPublicKey(hexToBytes(LOCK))

/** Far enough ahead to outlive a 365-day coupon minted at any test clock. */
export const DELEGATION_EXPIRES_AT = 4_000_000_000

/**
 * The stall's signed delegation of `coupon:issue` to `delegate`, as JSON.
 *
 * `d` replaces the record's `d` tag (null drops it); `extraD` adds a second.
 */
export function delegationJson(
  over: {
    stallSk?: string
    delegate?: string
    scope?: string
    expiresAt?: number
    d?: string | null
    extraD?: string
  } = {},
): string {
  const d = over.d === undefined ? 'imani:issuer-delegation' : over.d
  return JSON.stringify(
    finalizeEvent(
      {
        kind: 30078,
        created_at: 1_700_000_000,
        tags: [
          ...(d === null ? [] : [['d', d]]),
          ...(over.extraD ? [['d', over.extraD]] : []),
          ['p', over.delegate ?? LOCK_PUB],
          ['scope', over.scope ?? 'coupon:issue'],
          ['expiration', String(over.expiresAt ?? DELEGATION_EXPIRES_AT)],
        ],
        content: '',
      },
      hexToBytes(over.stallSk ?? STALL_SK),
    ),
  )
}

/**
 * A credential for `STALL` that can mint.
 *
 * The default delegation is signed ONCE, as it is in production (the vault
 * stores the stall's event). Re-signing per call would change its BIP-340
 * signature each time and make two attempts at one purchase send different
 * bodies under one idempotency key.
 */
let defaultDelegation: string | undefined
export function delegatedCredential(over: { credentialId?: string; delegation?: string } = {}) {
  defaultDelegation ??= delegationJson()
  return {
    stallPubkey: STALL,
    credentialId: over.credentialId ?? 'cred-1',
    lockKeyHex: LOCK,
    delegation: over.delegation ?? defaultDelegation,
  }
}

export { bytesToHex }

/**
 * A stall whose signed merchant record says 90 days (#312): the owner's own term, and the default
 * for every test that is not about validity.
 */
export const ninetyDayTerm = async () => ({ kind: 'days' as const, days: 90, source: 'record' as const })
