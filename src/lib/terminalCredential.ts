import { grantFor, roleOf, type TerminalRole } from './terminalRole'

/**
 * The wire shape of a real terminal credential.
 *
 * Terminals ticket 10. Until now a terminal carried a stand-in: a record the
 * device wrote for itself, which `terminalActor` re-checked but which nothing
 * outside the device ever signed. This is the shape of the real thing — a
 * voucher whose `merchant_metadata` the ISSUER signs, locked to the key the
 * terminal generated.
 *
 * ## Why this file exists separately from the minting
 *
 * The shape is defined once and imported by both the issuer and the reader,
 * exactly as `licenceIssue.ts` does for licences, and for the same reason: a
 * second copy of these key names is a credential the wallet silently stops
 * recognising. The failure is not a crash, it is a terminal that enrols
 * successfully and then cannot log in.
 *
 * ## The lock is the whole security property
 *
 * `lock_key` is the terminal's own public key, generated on the device and
 * never transmitted as a secret. A credential is inert without the matching
 * private half, which is what makes the enrolment QR safe to photograph across
 * a busy market — the fourth user story — and what ADR 0005 means by "a stolen
 * credential is not a credential".
 *
 * ## Permissions are DERIVED, never carried
 *
 * The credential names a role and a stall, and the permissions are computed
 * from them by `grantFor`. Carrying a permission list on the wire would create
 * a second source of truth that a tampered or stale credential could disagree
 * with — and the disagreement would favour whoever wrote the credential.
 */

/** The `merchant_metadata` keys. snake_case, like every wire shape here. */
export interface TerminalMetadata {
  /** Marks this voucher as a terminal credential rather than a coupon. */
  terminal: true
  /** The stall this terminal acts for. Read as the issuer, never the signer. */
  stall_pubkey: string
  role: TerminalRole
  /** The terminal's own public key. Authority is inert without its private half. */
  lock_key: string
  /** What the owner called it, so the terminal can name itself to its operator. */
  name?: string
}

/** What an owner must supply to mint one. */
export interface TerminalCredentialTerms {
  stallPubkey: string
  role: TerminalRole
  /** The key scanned off the terminal's screen. */
  lockKey: string
  name?: string
}

/**
 * The `merchant_metadata` JSON for a terminal credential.
 *
 * Every refusal here is a credential that would mint successfully and then fail
 * to work, which is the worst outcome: the owner believes the till is live and
 * discovers otherwise with a customer waiting. So they are refused at the point
 * of minting, where the owner is still holding both devices.
 */
export function terminalMetadataJson(terms: TerminalCredentialTerms): string {
  if (!terms.lockKey) {
    // Unlocked authority is bearer authority. Anyone who saw the voucher would
    // hold the stall's till, which is the one outcome this design exists to
    // prevent.
    throw new Error('a terminal credential must be locked to the device key')
  }
  if (!terms.stallPubkey) {
    throw new Error('a terminal credential must name the stall it acts for')
  }
  if (!roleOf(terms.role)) {
    // A credential with no valid role would derive an empty grant and be a
    // terminal that can do nothing — indistinguishable, to whoever holds it,
    // from a broken device.
    throw new Error('a terminal credential must carry a role from the catalog')
  }

  const metadata: TerminalMetadata = {
    terminal: true,
    stall_pubkey: terms.stallPubkey.toLowerCase(),
    role: terms.role,
    lock_key: terms.lockKey.toLowerCase(),
    ...(terms.name?.trim() ? { name: terms.name.trim() } : {}),
  }

  return JSON.stringify(metadata)
}

/**
 * Read a terminal credential back off a voucher's metadata.
 *
 * Returns null for anything that is not one, rather than throwing: a wallet
 * holds coupons and licences too, and "this is not a terminal credential" is an
 * ordinary answer rather than an error.
 *
 * Validates every field rather than casting. This is data that arrived from
 * outside — even signed, the SHAPE is still untrusted until checked, and a role
 * that is not in the catalog must not become permissions.
 */
export function parseTerminalMetadata(raw: unknown): TerminalMetadata | null {
  if (typeof raw !== 'string' || !raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const m = parsed as Partial<TerminalMetadata>

  // `terminal === true` explicitly, not truthy: a coupon whose metadata happens
  // to carry a "terminal" string must not be read as authority.
  if (m.terminal !== true) return null

  const role = roleOf(m.role)
  if (!role) return null
  if (typeof m.stall_pubkey !== 'string' || !HEX64.test(m.stall_pubkey)) return null
  if (typeof m.lock_key !== 'string' || !HEX64.test(m.lock_key)) return null

  return {
    terminal: true,
    stall_pubkey: m.stall_pubkey.toLowerCase(),
    role,
    lock_key: m.lock_key.toLowerCase(),
    ...(typeof m.name === 'string' && m.name ? { name: m.name } : {}),
  }
}

const HEX64 = /^[0-9a-f]{64}$/i

/**
 * The credential as this device's actor, if it is genuinely ours.
 *
 * Two independent checks, and BOTH must hold:
 *
 * 1. The credential is locked to THIS device's key. Authority held without the
 *    matching private half is inert — the ticket's second criterion.
 * 2. The issuer is the stall the credential names. A credential minted by
 *    anyone else grants nothing however well-formed it is, which is the check
 *    that stops a terminal minting its own authority.
 *
 * Permissions are derived here from the role and stall, never read from the
 * wire, so a credential cannot claim more than its role allows.
 */
export function credentialActor(
  metadata: TerminalMetadata,
  devicePubkey: string,
  { issuerPubkey }: { issuerPubkey: string },
): {
  kind: 'terminal'
  stallPubkey: string
  role: TerminalRole
  terminalPubkey: string
  permissions: readonly string[]
} | null {
  if (metadata.lock_key !== devicePubkey.toLowerCase()) return null

  // The issuer must be the STALL named in the credential. A voucher minted by
  // some other stall, or by the terminal itself, is refused even though its
  // signature is perfectly valid — "only for the stall that issued it".
  //
  // ONE comparison, not two. This took an `expectedIssuer` argument as well,
  // which a mutation control exposed as dead: the caller could only ever pass
  // the stall the credential already names, so the extra check could be deleted
  // with no test noticing. A parameter that cannot disagree with the data is
  // not defence in depth, it is a second thing to keep in sync.
  if (issuerPubkey.toLowerCase() !== metadata.stall_pubkey) return null

  return {
    kind: 'terminal',
    stallPubkey: metadata.stall_pubkey,
    role: metadata.role,
    terminalPubkey: metadata.lock_key,
    permissions: grantFor(metadata.role, metadata.stall_pubkey),
  }
}
