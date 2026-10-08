import { credentialActor, parseTerminalMetadata } from './terminalCredential'
import { openSession, SESSION_KIND, type TerminalSession } from './terminalSession'
import type { TerminalActor } from './actor'
import { parseVoucherToken, tokenProofs, verifyVoucher } from './voucherToken'
import { checkIssuer } from './issuerAllowlist'
import { lockedToPubkey, xOnly } from './witness'
import { ATTESTATION_REFUSAL, checkOwnerAttestation } from './ownerAttestation'
import { hasDuplicateKeys } from './terminalWarrant'

const LOWER_HEX64_STALL = /^[0-9a-f]{64}$/

/**
 * Terminal login: turn a stored credential back into a session.
 *
 * Terminals ticket 10. What a device does on launch, "without a person
 * present" — it holds a credential and its own key, and must decide what it may
 * do today.
 *
 * ## Permissions come from the CREDENTIAL, never from a stored record
 *
 * The ticket's third criterion, and the reason this module exists rather than
 * `storedTerminal()` being trusted directly. The record on disk is a
 * convenience; the credential is the authority. Anything editable by whoever
 * holds the device must not be able to widen what the device may do, so the
 * token is re-read and re-verified at every login and the permissions are
 * derived fresh from its role.
 *
 * ## Verification never spends
 *
 * The ticket's last criterion. Logging in re-reads bytes the device already
 * holds and checks a lock; it makes no call that could consume the credential.
 * A login that spent would mean a terminal could log in exactly once, and a
 * flat battery would cost an enrolment.
 *
 * ## Degraded login is redeem-only
 *
 * When the mint cannot be reached the credential's signature cannot be checked
 * against a live keyset, so the session opens REDUCED: redemption, never
 * issuance. A queue at a stall cannot wait for the network to agree, and
 * issuance is value-bearing. This is a deliberate, bounded weakening rather
 * than a bypass — the lock is still checked, because that check needs nobody.
 */

export const LOGIN_REFUSAL = {
  /** No credential on this device. It has never been enrolled, or was wiped. */
  NOT_ENROLLED: 'not-enrolled',
  /** The credential is not readable as a terminal credential at all. */
  UNREADABLE: 'unreadable',
  /** Not locked to this device, or not issued by the stall it names. */
  NOT_OURS: 'not-ours',
  /** The mint says the credential has been spent — the owner revoked it. */
  REVOKED: 'revoked',
  /**
   * The credential's signer is not a key this build trusts, or the build names none
   * (`VITE_VOUCHER_ISSUER_PUBKEYS`). Fails closed (#160 review, IW-15): the signature is checked
   * against a key the token carries, so without the allowlist anyone can sign one.
   */
  UNTRUSTED_ISSUER: 'untrusted-issuer',
  /**
   * The credential carries an owner attestation that does not hold: not signed by the stall it
   * names, or outlived by the credential (#160 decision 5, spec 4.6.3). The stall never signed
   * this till, so it is refused outright, unlike a credential with no attestation at all, which
   * opens for Redeem only.
   */
  BAD_ATTESTATION: 'bad-attestation',
} as const

export type LoginRefusal = (typeof LOGIN_REFUSAL)[keyof typeof LOGIN_REFUSAL]

export const LOGIN_MESSAGE: Record<LoginRefusal, string> = {
  [LOGIN_REFUSAL.NOT_ENROLLED]:
    'This device is not set up as a terminal yet. Ask the stall owner to add it.',
  [LOGIN_REFUSAL.UNREADABLE]:
    'This terminal’s authority cannot be read. Ask the stall owner to set it up again.',
  [LOGIN_REFUSAL.NOT_OURS]:
    'This authority is not for this device. Ask the stall owner to set it up again.',
  [LOGIN_REFUSAL.REVOKED]:
    'This terminal is no longer in service. Ask the stall owner to set it up again.',
  [LOGIN_REFUSAL.UNTRUSTED_ISSUER]:
    'This app cannot confirm who issued this terminal’s authority. Ask the stall owner to set it up again.',
  [LOGIN_REFUSAL.BAD_ATTESTATION]:
    'The stall did not sign this terminal’s authority. Take it out of service and ask the stall owner to set it up again.',
}

/**
 * What a till without the stall's attestation tells its operator (spec 4.6.5): it still
 * redeems, and selling needs the owner to set it up again, step by step, until phase 6's Renew.
 */
export const UNATTESTED_TILL_NOTICE =
  'Ask the owner to renew this terminal to sell. Redeeming still works. Until Renew arrives, ' +
  'renewing means: the owner revokes this terminal, you take it out of service ' +
  '(Settings → Security), and the owner adds it again with a new passphrase and setup code.'

export type LoginOutcome =
  | { admitted: true; actor: TerminalActor; session: TerminalSession }
  | { admitted: false; reason: LoginRefusal; message: string }

export interface LoginInput {
  /** The voucher's `merchant_metadata`, as stored. */
  merchantMetadata: unknown
  /**
   * The stall, from the voucher's `issuerId`.
   *
   * `issuerId`, NOT `issuerPublicKey`. The latter is the GATEWAY's signing key
   * and is identical on every voucher it mints, so checking the stall against
   * it refuses every real credential — found by minting one for real, and
   * invisible to fixtures this app wrote for itself.
   */
  issuerId: string
  /** This device's own public key. */
  devicePubkey: string
  /**
   * Whether the credential is still unspent, if we could ask.
   *
   * `null` means we could not reach the mint. That is NOT treated as revoked:
   * failing closed here would take a stall off the market every time its
   * connection dropped, which is the outcome the whole degraded-login design
   * exists to avoid. It opens a REDUCED session instead.
   */
  unspent: boolean | null
  openedAt?: number
  /**
   * Whether the stall attested this credential (`credentialFromToken`). Only `true` lets a
   * selling role sell: absent or false opens the till for Redeem only (spec 4.6.5).
   */
  attested?: boolean
}

/**
 * Admit this device, or say why not.
 *
 * The order is deliberate: cheap local checks first, and the mint's answer
 * last, so a device with a credential meant for another terminal is refused
 * without a network round trip.
 */
export function loginTerminal({
  merchantMetadata,
  issuerId,
  devicePubkey,
  unspent,
  openedAt = Date.now(),
  attested = false,
}: LoginInput): LoginOutcome {
  if (merchantMetadata === null || merchantMetadata === undefined || merchantMetadata === '') {
    return refuse(LOGIN_REFUSAL.NOT_ENROLLED)
  }

  const metadata = parseTerminalMetadata(merchantMetadata)
  if (!metadata) return refuse(LOGIN_REFUSAL.UNREADABLE)

  // The lock and the issuer, checked together. Both need nothing but the bytes
  // in hand, which is why they still hold with the mint unreachable.
  const actor = credentialActor(metadata, devicePubkey, { issuerId })
  if (!actor) return refuse(LOGIN_REFUSAL.NOT_OURS)

  // Only a definite NO from the mint revokes. `null` is "we could not ask".
  if (unspent === false) return refuse(LOGIN_REFUSAL.REVOKED)

  const attestedActor = { ...actor, attested: attested === true } as TerminalActor
  return {
    admitted: true,
    actor: { ...attestedActor, name: metadata.name } as TerminalActor,
    session: openSession(
      attestedActor,
      // Reduced when the mint could not confirm the credential is live. The
      // terminal still redeems, because a queue cannot wait; it does not issue,
      // because issuing on an authority nobody could check is money created on
      // a guess.
      unspent === true ? SESSION_KIND.FULL : SESSION_KIND.REDUCED,
      openedAt,
    ),
  }
}

function refuse(reason: LoginRefusal): LoginOutcome {
  return { admitted: false, reason, message: LOGIN_MESSAGE[reason] }
}

/** What a stored credential token says about itself, once its bytes check out. */
export interface CredentialFacts {
  /** The voucher's signed `merchant_metadata`, as `loginTerminal` takes it. */
  merchantMetadata: string
  /** The voucher's signed `issuerId`: the stall. */
  issuerId: string
  voucherId: string
  /** Unix seconds, from the signed voucher. Undefined when the voucher carries none. */
  expiresAt?: number
  /**
   * The stall signed this credential's `owner_attestation`, and the credential does not outlive
   * it (spec 4.6.3). False when it carries none: a legacy till, which opens for Redeem only. A
   * present but invalid attestation never gets this far: the credential is refused.
   */
  attested: boolean
}

/**
 * Read a terminal credential from its own token bytes (#160 phase 3, spec 4.5, IW-15).
 *
 * The device record used to carry `merchantMetadata` and `issuerId` beside the token, and login
 * trusted them. Both are editable by anyone holding the device, so a redeem-only record could be
 * edited into an issuing one. Here they come from the token, and only after:
 *
 * - the token is one `P2PK_VOUCHER` proof whose lock (`data`) is the metadata's `lock_key`, so
 *   the metadata cannot name a different device than the mint enforces;
 * - the voucher's signature verifies over its canonical bytes (`verifyVoucher`), so the metadata
 *   is the signer's and was not altered;
 * - the signer is one of the keys this build trusts (`VITE_VOUCHER_ISSUER_PUBKEYS`, ADR 0006).
 *   **Required, not opt-in** (#160 review, IW-15): `verifyVoucher` checks the signature against
 *   the `issuer_pubkey` the token itself carries, so a signature alone proves nothing about who
 *   signed. With no allowlist, a credential re-signed with any key would open an issuing till for
 *   any stall. So a build that names no keys admits no terminal at all.
 *
 * Null on anything else, which `loginTerminal` reads as an unreadable credential.
 */
export function credentialFromToken(token: string): CredentialFacts | null {
  const read = readCredential(token)
  return 'facts' in read ? read.facts : null
}

/** `credentialFromToken`, saying which check refused it. */
function readCredential(token: string): { facts: CredentialFacts } | { refusal: LoginRefusal } {
  const unreadable = { refusal: LOGIN_REFUSAL.UNREADABLE }
  try {
    const proofs = tokenProofs(token)
    if (proofs.length !== 1) return unreadable
    const secret = proofs[0].secret
    if (!secret.startsWith('["P2PK_VOUCHER"')) return unreadable

    const parsed = parseVoucherToken(token)
    const voucher = parsed.voucher
    const metadata = parseTerminalMetadata(voucher.merchantMetadata)
    if (!metadata) return unreadable

    // The key the MINT enforces must be the key the metadata names. Otherwise a credential
    // could claim one device in its metadata while being spendable by another.
    const lock = lockedToPubkey(secret)
    if (!lock || xOnly(lock).toLowerCase() !== metadata.lock_key) return unreadable

    if (!verifyVoucher(voucher).signatureValid) return unreadable
    // 'allowed' only. 'unchecked' (no allowlist in this build) is a refusal for a terminal
    // credential, unlike for a customer's coupon: see the function comment.
    if (checkIssuer(parsed) !== 'allowed') return { refusal: LOGIN_REFUSAL.UNTRUSTED_ISSUER }

    // The stall's attestation (#160 decision 5), on the metadata the service's signature just
    // covered, against the stall the voucher names. Missing means a legacy till: admitted, for
    // Redeem only. Present and not holding means the stall never signed this till: refused.
    const attestation = ownerAttestationOf(String(voucher.merchantMetadata), voucher.issuerId, voucher.expiresAt)
    if (attestation === 'bad') return { refusal: LOGIN_REFUSAL.BAD_ATTESTATION }

    return {
      facts: {
        attested: attestation === 'attested',
        merchantMetadata: String(voucher.merchantMetadata),
        issuerId: voucher.issuerId,
        voucherId: voucher.voucherId,
        ...(typeof voucher.expiresAt === 'number' ? { expiresAt: voucher.expiresAt } : {}),
      },
    }
  } catch {
    return unreadable
  }
}

/**
 * The device's attestation check, `verifyOwnerAttestation`'s steps on metadata already verified.
 *
 * Not the strict credential parser: tokens minted before 0.16.1 serialised some tags in ways it
 * refuses, and the device has already verified this token's signature and lock itself. But the
 * metadata is read as strictly as the verifiers read it: a repeated key is never attested, and
 * `stall_pubkey` must equal `issuerId` exactly. So "attested" here implies the verifiers accept
 * the attestation step. The
 * digest is rebuilt from the metadata's own `stall_pubkey`, `lock_key` and `role`, verbatim.
 */
function ownerAttestationOf(
  metadataJson: string,
  issuerId: string,
  expiresAt: number | undefined,
): 'attested' | 'missing' | 'bad' {
  let metadata: unknown
  try {
    metadata = JSON.parse(metadataJson)
  } catch {
    return 'missing'
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'missing'
  const m = metadata as Record<string, unknown>
  if (!('owner_attestation' in m)) return 'missing'
  // A repeated key at any depth: `JSON.parse` kept the last one, but every verifier's strict
  // parse refuses the whole credential, so it can never sell. Never attested here either; read
  // as missing (Redeem only), like any other attestation the verifiers would not read.
  if (hasDuplicateKeys(metadataJson)) return 'missing'
  // An attestation over a credential with no expiry would bound nothing. Refused, not read as
  // missing: the stall signed something, and not this.
  if (expiresAt === undefined || !Number.isSafeInteger(expiresAt) || expiresAt < 0) return 'bad'
  // As the verifiers read it: `stall_pubkey` lowercase hex, exactly the stall. An uppercase
  // spelling (even one the stall signed in uppercase) is what every verifier refuses.
  const stall = issuerId.toLowerCase()
  if (typeof m.stall_pubkey !== 'string' || !LOWER_HEX64_STALL.test(m.stall_pubkey) || m.stall_pubkey !== stall) {
    return 'bad'
  }
  const refusal = checkOwnerAttestation(m, stall, String(expiresAt))
  if (refusal === null) return 'attested'
  // Present but malformed reads as missing in the Java (OWNER_ATTESTATION_MISSING), so here too:
  // the till keeps Redeem. Only a well-formed attestation that fails is a refusal.
  return refusal === ATTESTATION_REFUSAL.OWNER_ATTESTATION_MISSING ? 'missing' : 'bad'
}

/**
 * Log a terminal in from the token it holds, never from fields stored beside it.
 *
 * The same decision as `loginTerminal`, with its inputs read from the signed token. An
 * unreadable token is refused as UNREADABLE before the mint answer is considered, so an edited
 * token is never admitted on a REDUCED session either.
 */
export function loginFromToken({
  token,
  devicePubkey,
  unspent,
  openedAt,
}: {
  token: string
  devicePubkey: string
  unspent: boolean | null
  openedAt?: number
}): LoginOutcome {
  const read = readCredential(token)
  if (!('facts' in read)) return refuse(read.refusal)
  const { facts } = read
  return loginTerminal({
    merchantMetadata: facts.merchantMetadata,
    issuerId: facts.issuerId,
    devicePubkey,
    unspent,
    attested: facts.attested,
    ...(openedAt !== undefined ? { openedAt } : {}),
  })
}
