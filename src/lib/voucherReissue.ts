/**
 * Asking the issuing gateway to sign a voucher secret this wallet chose.
 *
 * ## Why a voucher receive needs a round trip at all
 *
 * The wallet swaps its own receives, so the gateway never holds a spendable copy
 * of a received coupon. Plain ecash needs nothing from the gateway for that: an
 * output secret is just an unpredictable string, and the wallet can invent one.
 *
 * A voucher's secret is not arbitrary. It carries the coupon's id, face value,
 * expiry, issuance warrant, the key it is locked to, and the ISSUER'S SIGNATURE
 * over all of that. Receiving one re-locks it to the receiver and re-nonces it, and
 * both of those are inside what the issuer signed, so the old signature no longer
 * verifies. Only the issuing gateway holds the key that can make a new one.
 *
 * So the wallet proposes the fresh secret and asks for a signature over it. The
 * gateway sees the secret and never the blinding factor, so the proof the wallet
 * goes on to mint is not spendable by the gateway. A signing step, not custody.
 *
 * ## What the gateway will refuse, and why a refusal is not a failure
 *
 * A signature is granted only when the gateway issued the predecessor, the mint
 * confirms that predecessor is SPENT, that burn has not already bought a
 * signature, and the proposal changes nothing but the lock key and the nonce.
 *
 * `PREDECESSOR_NOT_SPENT` is the one worth retrying, and the only one: the swap
 * may simply not have landed yet. Everything else will answer the same way however
 * often it is asked, and a client that retries them is wasting the user's time
 * while their coupon sits unreceived.
 *
 * A lost RESPONSE is different, and safe to retry. Resending the identical
 * predecessor and proposal returns the identical signed successor, because the
 * gateway stores what each burn bought. So a caller that timed out must resend
 * the SAME proposal, never invent a fresh one: a fresh proposal for a burn that
 * already bought a successor is refused as `PREDECESSOR_ALREADY_CLAIMED`, and
 * the coupon is then only recoverable from the proposal that won.
 *
 * That distinction arrives as an HTTP status, so a caller does not have to parse
 * prose to decide. See imani-gateway-customer#135.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils'

import { getSigner } from './nap'
import { signedFetch, type RequestSigner } from './nip98'

const REISSUE_PATH = '/api/v1/wallet/vouchers/reissue'

/**
 * Versioned domain tag. It keeps this signature apart from a NUT-11 spend witness,
 * which the same key makes over `sha256(secret)`, so neither can stand in for the
 * other.
 */
const LOCK_AUTHORIZATION_TAG = 'imani/voucher-reissue/v1'

/**
 * Lends the lock key for the length of one call and wipes it afterwards (IW-14),
 * exactly as `WalletSigner.withPrivkey` does. Taken instead of a raw key so this
 * module never holds, receives or keeps a copy the signer cannot account for.
 */
export type LockKeyLender = <T>(borrow: (key: Uint8Array) => T) => T

/**
 * `sha256(TAG || u32be(len) || predecessor || u32be(len) || proposed)`, secrets as
 * UTF-8. Naming both secrets binds the signature to this one coupon and this one
 * proposal. The lengths make the boundary unambiguous whatever the secrets
 * contain. Must match the gateway's `LockAuthorization` byte for byte.
 */
function reissueMessage(predecessor: string, proposed: string): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = [encoder.encode(LOCK_AUTHORIZATION_TAG)]
  for (const secret of [predecessor, proposed]) {
    const bytes = encoder.encode(secret)
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, bytes.length, false)
    parts.push(length, bytes)
  }
  const message = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    message.set(part, offset)
    offset += part.length
  }
  return sha256(message)
}

/** The holder's BIP-340 signature over {@link reissueMessage}, as hex. */
function lockAuthorization(lendKey: LockKeyLender, predecessor: string, proposed: string): string {
  const digest = reissueMessage(predecessor, proposed)
  return bytesToHex(lendKey((key) => schnorr.sign(digest, key)))
}

/** Why the gateway would not sign, as it named it. */
export type ReissueRefusal =
  | 'NOT_A_LOCKED_VOUCHER'
  /** The request was not signed by the key the coupon is locked to (#136). */
  | 'NOT_AUTHORISED_BY_HOLDER'
  | 'NOT_OUR_ISSUANCE'
  | 'PREDECESSOR_NOT_AUTHENTIC'
  | 'TERMS_CHANGED'
  | 'PREDECESSOR_NOT_SPENT'
  | 'PREDECESSOR_ALREADY_CLAIMED'
  /** The gateway answered in a way this client does not understand. */
  | 'UNKNOWN'

export class VoucherReissueRefused extends Error {
  constructor(
    readonly refusal: ReissueRefusal,
    /**
     * Whether asking again, unchanged, could succeed.
     *
     * Carried as a FLAG rather than left for the caller to infer from the code,
     * because inferring it means restating the gateway's rules here, and two
     * copies of that rule would drift. The gateway says so in its status.
     */
    readonly retryable: boolean,
    message: string,
  ) {
    super(message)
    this.name = 'VoucherReissueRefused'
  }
}

interface ReissueResponseBody {
  signed_secret?: string
  refusal?: string
}

/**
 * Known refusal, or `UNKNOWN`.
 *
 * Unrecognised values are not passed through as-is. A future gateway may add a
 * refusal this build has never heard of, and treating an unknown string as a
 * known one is how a caller ends up branching on a case it does not handle.
 */
function asRefusal(value: string | undefined): ReissueRefusal {
  switch (value) {
    case 'NOT_A_LOCKED_VOUCHER':
    case 'NOT_AUTHORISED_BY_HOLDER':
    case 'NOT_OUR_ISSUANCE':
    case 'PREDECESSOR_NOT_AUTHENTIC':
    case 'TERMS_CHANGED':
    case 'PREDECESSOR_NOT_SPENT':
    case 'PREDECESSOR_ALREADY_CLAIMED':
      return value
    default:
      return 'UNKNOWN'
  }
}

/**
 * Get a fresh issuer signature over `proposedSecret`.
 *
 * Both arguments are the exact NUT-10 secret STRING the mint hashes to derive Y.
 * Re-serialising either changes that string, and a predecessor whose string form
 * differs is one the mint reports as unknown, so the gateway refuses.
 *
 * The request carries `lock_authorization`, a signature by the key the predecessor is
 * locked to, which the gateway requires (imani-gateway-customer#136): knowing a
 * coupon's secret is not holding it, because whoever handed the coupon over authored
 * that secret. The caller is always the coupon's current holder, re-locking their own
 * coupon, so the key is the wallet's own. It is borrowed from the session signer for
 * the one signature and wiped afterwards. `lendKey` exists for tests.
 *
 * @param predecessorSecret the secret of the proof being replaced, already spent
 * @param proposedSecret    the fresh secret, differing only in lock key and nonce
 * @returns the proposed secret carrying a valid issuer signature
 * @throws VoucherReissueRefused when the gateway declined, with `retryable` set
 */
export async function reissueVoucherSecret(
  predecessorSecret: string,
  proposedSecret: string,
  options: { lendKey?: LockKeyLender; signal?: AbortSignal; signer?: RequestSigner } = {},
): Promise<string> {
  const lendKey: LockKeyLender = options.lendKey ?? ((borrow) => getSigner().withPrivkey(borrow))
  const response = await signedFetch(
    REISSUE_PATH,
    'POST',
    {
      predecessor_secret: predecessorSecret,
      proposed_secret: proposedSecret,
      lock_authorization: lockAuthorization(lendKey, predecessorSecret, proposedSecret),
    },
    // Defaults to the session signer. Taken as an option for the reason
    // `nip98Header` gives: a test, and registration, need to sign with a key that
    // is not the session's, and a function that can only reach a global signer is
    // a function whose one security-relevant input cannot be varied.
    options.signer,
    options,
  )

  // A 404 means the gateway has no mint configured, so its re-signer has no bound
  // and the route is absent by design rather than missing by accident. Named
  // separately because "this deployment cannot do voucher receives" is an
  // operator's problem, not a retry.
  if (response.status === 404) {
    throw new VoucherReissueRefused(
      'UNKNOWN',
      false,
      'this gateway exposes no voucher re-signing route, so it cannot receive vouchers',
    )
  }

  let body: ReissueResponseBody
  try {
    body = (await response.json()) as ReissueResponseBody
  } catch {
    throw new VoucherReissueRefused(
      'UNKNOWN',
      // A body we cannot read tells us nothing about whether a retry would help,
      // and retrying a signing request blindly is how a burn gets spent on a
      // request that was never going to succeed.
      false,
      `the gateway's answer could not be read (HTTP ${response.status})`,
    )
  }

  if (response.ok && body.signed_secret) {
    return body.signed_secret
  }

  // 409 is the gateway's way of saying "well-formed request, world not yet in the
  // required state". Read from the STATUS rather than the refusal code, so the
  // retry rule lives in one place: the gateway's.
  const retryable = response.status === 409
  const refusal = asRefusal(body.refusal)
  throw new VoucherReissueRefused(
    refusal,
    retryable,
    `the gateway would not re-sign this voucher: ${refusal} (HTTP ${response.status})`,
  )
}
