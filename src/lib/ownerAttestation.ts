/**
 * The stall owner attests each terminal credential (#160 decision 5, spec 4.6).
 *
 * A terminal credential is signed by the issuing service alone, and the service is the one key
 * issuance warrants exist to distrust. So at enrolment the owner's wallet signs, with the stall
 * key that signs `merchant` warrants, a statement that this stall lets `K` act as `role` until
 * `T`. It travels inside the credential's signed `merchant_metadata` as `owner_attestation`
 * (option A), so it can never be paired with the wrong credential.
 *
 * Every verifier of a terminal's authority to sell then checks two signatures: the service's
 * over the credential, and the stall's over this attestation. The digest and the refusals mirror
 * cashu-voucher 0.17.0 (`IssuanceWarrant.attestationDigest`, `verifyOwnerAttestation`), and the
 * parity test loads that release's golden vectors (`ownerAttestationParity.test.ts`).
 *
 * Wire form, every value a string so Java and TypeScript read the same characters:
 *
 *     "owner_attestation": {"v":"1","expires_at":"<T>","nonce":"<64 hex>","sig":"<128 hex>"}
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

/** The first field of the digest, so it can never equal a sale digest (that starts with a key). */
export const ATTESTATION_DOMAIN = 'imani-terminal-attestation'
/** The only version there is. */
export const ATTESTATION_VERSION = '1'
/** U+001F, the separator `warrantSaleDigest` uses too. */
const US = '\u001f'

const LOWER_HEX64 = /^[0-9a-f]{64}$/
const LOWER_HEX128 = /^[0-9a-f]{128}$/
const CANONICAL_INTEGER = /^(0|[1-9][0-9]{0,18})$/
/** Java's Long.MAX_VALUE: a canonical integer above it does not parse there, so not here. */
const JAVA_LONG_MAX = 9_223_372_036_854_775_807n
const ATTESTATION_KEYS = ['expires_at', 'nonce', 'sig', 'v']

/** The `owner_attestation` object, as it sits in the credential's metadata. */
export interface OwnerAttestation {
  v: string
  /** `T`, epoch seconds, canonical decimal. */
  expires_at: string
  /** 32 random bytes the owner chose, lowercase hex. */
  nonce: string
  /** BIP-340 by the stall over `attestationDigest`, lowercase hex. */
  sig: string
}

/** The refusals cashu-voucher 0.17.0 added. Same names as `IssuanceWarrant.TerminalRefusal`. */
export const ATTESTATION_REFUSAL = {
  /** Absent, or not exactly the four string fields in canonical form. */
  OWNER_ATTESTATION_MISSING: 'OWNER_ATTESTATION_MISSING',
  /** Well-formed, and the stall's signature does not verify. */
  BAD_OWNER_ATTESTATION: 'BAD_OWNER_ATTESTATION',
  /** The credential outlives what the owner signed: its `expires_at` is after `T`. */
  ATTESTATION_EXCEEDED: 'ATTESTATION_EXCEEDED',
} as const

export type AttestationRefusal = (typeof ATTESTATION_REFUSAL)[keyof typeof ATTESTATION_REFUSAL]

/**
 * `sha256(utf8(join(US, domain, v, S, K, role, expires_at, nonce)))`, spec 4.6.2.
 *
 * Every argument is used verbatim: the verifier reads `S`, `K` and `role` back from the same
 * metadata the attestation sits in, so the two cannot disagree.
 */
export function attestationPreimage(
  v: string,
  stallPubkey: string,
  lockKey: string,
  role: string,
  expiresAt: string,
  nonce: string,
): Uint8Array {
  return new TextEncoder().encode([ATTESTATION_DOMAIN, v, stallPubkey, lockKey, role, expiresAt, nonce].join(US))
}

export function attestationDigest(
  v: string,
  stallPubkey: string,
  lockKey: string,
  role: string,
  expiresAt: string,
  nonce: string,
): Uint8Array {
  return sha256(attestationPreimage(v, stallPubkey, lockKey, role, expiresAt, nonce))
}

/** What signs: the stall's own signer, as `buildIssuanceWarrant` uses for a `merchant` warrant. */
export interface StallSigner {
  pubkey: string
  withPrivkey<T>(borrow: (key: Uint8Array) => T): T
}

/**
 * Sign the attestation for one enrolment, with the stall key.
 *
 * Throws when the signer is not the stall: an attestation by any other key would be refused by
 * every verifier, and a till minted with it could never sell.
 */
export function signOwnerAttestation(
  terms: { stallPubkey: string; lockKey: string; role: string; expiresAt: number },
  signer: StallSigner,
  nonce: string = bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
): OwnerAttestation {
  const stall = terms.stallPubkey.toLowerCase()
  if (signer.pubkey.toLowerCase() !== stall) {
    throw new Error('Only the stall’s own key can attest a terminal. Sign in as the stall owner.')
  }
  if (!Number.isSafeInteger(terms.expiresAt) || terms.expiresAt < 0) {
    throw new Error('A terminal’s attestation needs a whole-second expiry.')
  }
  const expiresAt = String(terms.expiresAt)
  const digest = attestationDigest(
    ATTESTATION_VERSION,
    stall,
    terms.lockKey.toLowerCase(),
    terms.role,
    expiresAt,
    nonce,
  )
  const sig = signer.withPrivkey((key) => bytesToHex(schnorr.sign(digest, key)))
  return { v: ATTESTATION_VERSION, expires_at: expiresAt, nonce, sig }
}

/**
 * The attestation in a metadata object, or null when it is absent or malformed.
 *
 * Malformed is exactly what the Java reads as `OWNER_ATTESTATION_MISSING`: not an object, any key
 * besides the four (or one missing), a non-string value, `v` other than "1", a non-canonical or
 * out-of-range `expires_at`, a nonce or signature that is not lowercase hex of the right length.
 */
export function readOwnerAttestation(metadata: Record<string, unknown>): OwnerAttestation | null {
  const raw = metadata.owner_attestation
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const a = raw as Record<string, unknown>
  const keys = Object.keys(a).sort()
  if (keys.length !== ATTESTATION_KEYS.length || keys.some((k, i) => k !== ATTESTATION_KEYS[i])) return null
  const { v, expires_at, nonce, sig } = a
  if (typeof v !== 'string' || typeof expires_at !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
    return null
  }
  if (v !== ATTESTATION_VERSION) return null
  if (!CANONICAL_INTEGER.test(expires_at) || BigInt(expires_at) > JAVA_LONG_MAX) return null
  if (!LOWER_HEX64.test(nonce) || !LOWER_HEX128.test(sig)) return null
  return { v, expires_at, nonce, sig }
}

/**
 * The attestation step every verifier runs (spec 4.6.3), on metadata already read as a terminal
 * credential's, in the Java's order: missing, then the signature, then the expiry bound.
 *
 * @param metadata the credential's parsed `merchant_metadata`
 * @param issuerId the stall, which must have signed; callers have already required it to equal
 *   the metadata's `stall_pubkey`
 * @param credentialExpiresAt the credential's own signed `expires_at`, canonical decimal
 * @returns null when the stall attested this credential, else why not
 */
export function checkOwnerAttestation(
  metadata: Record<string, unknown>,
  issuerId: string,
  credentialExpiresAt: string,
): AttestationRefusal | null {
  const attestation = readOwnerAttestation(metadata)
  if (!attestation) return ATTESTATION_REFUSAL.OWNER_ATTESTATION_MISSING
  const { stall_pubkey: stall, lock_key: lockKey, role } = metadata
  if (typeof stall !== 'string' || typeof lockKey !== 'string' || typeof role !== 'string') {
    return ATTESTATION_REFUSAL.BAD_OWNER_ATTESTATION
  }
  try {
    const digest = attestationDigest(attestation.v, stall, lockKey, role, attestation.expires_at, attestation.nonce)
    if (!schnorr.verify(hexToBytes(attestation.sig), digest, hexToBytes(issuerId))) {
      return ATTESTATION_REFUSAL.BAD_OWNER_ATTESTATION
    }
  } catch {
    return ATTESTATION_REFUSAL.BAD_OWNER_ATTESTATION
  }
  if (BigInt(credentialExpiresAt) > BigInt(attestation.expires_at)) return ATTESTATION_REFUSAL.ATTESTATION_EXCEEDED
  return null
}
