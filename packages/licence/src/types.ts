/**
 * The shapes a licence check works in, and the reasons it can refuse.
 */

/**
 * A licence voucher, in the fields this check reads.
 *
 * Deliberately NOT the wallet's `SignedVoucherFields`. That type is the app's,
 * it carries a dozen fields about money this check has no use for, and importing
 * it would tie this package to `src/lib` — the one thing the package boundary
 * exists to prevent (ADR 0007).
 *
 * The caller parses a token into this. Parsing is the app's job because it needs
 * the app's CBOR reader; deciding is this package's job because it needs no one.
 */
export interface LicenceVoucher {
  /** Stable across renewals and re-issues. The thread support follows. */
  subscriptionId?: string
  /** Who signed it. Compared against the expected issuer, never trusted alone. */
  issuerPublicKey: string
  /** Schnorr signature over the voucher's canonical bytes. */
  issuerSignature: string
  /**
   * The key this voucher is locked to. The presenter must hold it.
   *
   * Optional because the composite `P2PK_VOUCHER` kind is not yet what the
   * wallet's parser produces — it reads a plain `VOUCHER` secret, which carries
   * no lock key. A voucher without one is REFUSED rather than accepted, so this
   * being optional widens the type without widening what is allowed.
   */
  lockKey?: string
  /** Unix SECONDS. A licence with no expiry is refused rather than eternal. */
  expiresAt?: number
  /** What was paid, so the credential is its own receipt. */
  faceValue?: number
  faceUnit?: string
  /** Feature names this licence confers. */
  features?: readonly string[]
  /** Marks a pilot, so support and revenue are not guesses. */
  pilot?: boolean
}

/** What a verified licence confers. */
export interface LicenceGrant {
  features: readonly string[]
  subscriptionId?: string
  /** Unix SECONDS, so a caller can show "until when" without re-deriving it. */
  expiresAt: number
  pilot: boolean
}

/**
 * Why a licence granted nothing.
 *
 * Named rather than a boolean, because these are the sentences a support
 * conversation is made of — "your subscription ended on the 3rd" and "that
 * licence is not for this device" are different problems with different
 * remedies, and a caller that only knows `false` can say neither.
 */
export const DENIAL_REASONS = {
  /** No voucher at all. Not an error: the ordinary state of a free stall. */
  ABSENT: 'absent',
  /** Signed by someone who is not us. */
  WRONG_ISSUER: 'wrong-issuer',
  /** Signed by us, but the signature does not check out over these fields. */
  BAD_SIGNATURE: 'bad-signature',
  /** Locked to a different key than the one presenting it. */
  WRONG_KEY: 'wrong-key',
  /** Carries no lock key at all, so possession alone would be enough. */
  UNLOCKED: 'unlocked',
  /** Past its expiry, decided from the signed field and the caller's clock. */
  EXPIRED: 'expired',
  /** No expiry field. Refused rather than treated as eternal. */
  NO_EXPIRY: 'no-expiry',
  /** Verified, and confers nothing. A licence for no features is not a licence. */
  NO_FEATURES: 'no-features',
} as const

export type DenialReason = (typeof DENIAL_REASONS)[keyof typeof DENIAL_REASONS]

export type LicenceVerdict =
  | { granted: true; grant: LicenceGrant }
  | { granted: false; reason: DenialReason; detail: string }

export interface VerifyOptions {
  /**
   * OUR issuer public key, 32-byte hex.
   *
   * Required, with no default. A default here would be a licence check that
   * passes for a voucher anyone minted, which is the one failure this module
   * exists to prevent — and `nap-voucher` refuses to default its allowlist for
   * the same reason.
   */
  issuerPublicKey: string
  /**
   * Now, in unix SECONDS, supplied rather than read.
   *
   * The whole point of a pure verifier: expiry boundaries are testable by moving
   * a number instead of waiting, and a caller that wants to ask "was this valid
   * last Tuesday" can.
   */
  now: number
  /** The key presenting the voucher — for a request, the one that signed it. */
  presenter: string
  /**
   * Verify a schnorr signature over the voucher's canonical bytes.
   *
   * Injected because canonicalisation belongs to the voucher format and lives in
   * the app, while the DECISION belongs here. Passing it in keeps this package
   * free of a crypto dependency and of the app's encoder, and lets a test drive
   * the branch where a signature fails without forging one.
   */
  verifySignature: (voucher: LicenceVoucher) => boolean
}
