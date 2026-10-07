import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'

import { signedFetch } from './nip98'
import { parseTerminalMetadata, terminalMetadataJson } from './terminalCredential'
import { parseVoucherToken, tokenProofs, verifyVoucher } from './voucherToken'
import { spendingKeys, xOnly } from './witness'
import type { PreparedCredential } from './terminalIssue'

/**
 * The owner's phone mints a terminal's credential, and checks what came back (#160 phase 1).
 *
 * Until this existed the enrolment screen built the credential's description and threw it
 * away (G1), and the only way to mint one was `scripts/mint-terminal-credential.mjs` (G2).
 * This is that script's request, made from the owner's own session, plus the one thing the
 * script never did: refuse to keep a credential that is not what was asked for.
 *
 * ## What "what was asked for" means
 *
 * The gateway is trusted to mint, not to mint correctly. A credential that came back as a
 * plain `VOUCHER` (the gateway's fallback for a key it cannot lock to), locked to some other
 * key, without the stall as co-spender, or with different metadata, is not a terminal the
 * owner can control. It would be a bearer authority to their stall, or one they cannot revoke.
 * So every property is checked from the token's own bytes, and a credential that fails is
 * spent at once, by the stall, wherever possible, before the failure is reported.
 */

/** Days a credential lasts. Decision 1 on #160: a year, with renewal warnings later. */
export const CREDENTIAL_LIFETIME_DAYS = 365

/** How long the gateway gets to produce the token after accepting the request. */
const TOKEN_WAIT_MS = 60_000
const TOKEN_POLL_MS = 2_000

/** What this module needs of the network. Injected so tests need none. */
export interface MintTransport {
  /** `headers` carries the `Idempotency-Key`, so a re-sent request replays rather than re-mints. */
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>
  get(path: string): Promise<Response>
  sleep(ms: number): Promise<void>
}

/** The owner's own NIP-98 signer, which is what makes the gateway resolve the issuer as the stall. */
export const ownerTransport: MintTransport = {
  post: (path, body, headers) => signedFetch(path, 'POST', body, undefined, { headers }),
  get: (path) => signedFetch(path, 'GET'),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** A credential the gateway minted and this module has checked. */
export interface MintedCredential {
  voucherId: string
  token: string
  /** Epoch seconds, from the signed `expires_at`. */
  expiresAt?: number
}

/**
 * The request body, exactly as `scripts/mint-terminal-credential.mjs` sends it.
 *
 * A terminal credential is not money: one sat, the smallest face the gateway accepts, because
 * the voucher only carries the signed metadata. The stall is named as issuer so the gateway
 * can refuse the request if the caller is anyone else.
 */
export function credentialRequestBody(credential: PreparedCredential): Record<string, unknown> {
  return {
    face_value: 1,
    face_unit: 'sat',
    face_decimals: 0,
    backing_strategy: 'PROPORTIONAL',
    issuer_id: credential.stallPubkey,
    memo: 'Imani terminal credential',
    expires_in_days: CREDENTIAL_LIFETIME_DAYS,
    // Not IW-15: `credential` is the owner's own in-memory form (prepareEnrolment), never a
    // stored record, and the gateway signs exactly this metadata into the token, which the
    // owner then re-checks from the token's bytes (credentialDefect).
    merchant_metadata: JSON.parse(
      // nosemgrep: imani-role-from-local-storage
      terminalMetadataJson({
        stallPubkey: credential.stallPubkey,
        role: credential.role,
        lockKey: credential.lockedTo,
        name: credential.name,
        // Signed, so the device reads the owner's idle lock from the token rather than from
        // its own editable record (#160 review, LOW).
        ...(credential.idleLockMinutes !== undefined ? { idleLockMinutes: credential.idleLockMinutes } : {}),
      }),
    ),
  }
}

/** Why a minted credential was refused. Each is a property the owner relies on. */
export type CredentialDefect =
  | 'unreadable'
  | 'not-locked'
  | 'wrong-lock'
  | 'no-stall-co-key'
  | 'wrong-issuer'
  | 'bad-signature'
  | 'metadata-mismatch'

/**
 * Does this token hold exactly the credential that was asked for?
 *
 * Read from the token's own bytes, never from the gateway's JSON around it:
 *
 * - one proof, a `P2PK_VOUCHER` (mint-enforced lock), with `data` = the device key;
 * - the stall in `pubkeys` with `n_sigs` 1, so the owner can revoke it (spec 4.3);
 * - issued by the stall, with a valid issuer signature;
 * - signed metadata naming the same stall, role and lock key as requested.
 *
 * @returns null when it is right, else the first defect found
 */
export function credentialDefect(token: string, expected: PreparedCredential): CredentialDefect | null {
  let secret: string
  let parsed: ReturnType<typeof parseVoucherToken>
  try {
    const proofs = tokenProofs(token)
    if (proofs.length !== 1) return 'unreadable'
    secret = proofs[0].secret
    parsed = parseVoucherToken(token)
  } catch {
    return 'unreadable'
  }

  if (!secret.startsWith('["P2PK_VOUCHER"')) return 'not-locked'

  const keys = spendingKeys(secret).map((k) => xOnly(k).toLowerCase())
  // `data` is first. It must be the device.
  if (keys[0] !== expected.lockedTo) return 'wrong-lock'
  // And the co-spenders must be EXACTLY the stall (#160 review): a third key
  // in `pubkeys` could spend the credential too, and refund or locktime tags
  // would add spending paths the owner never agreed to.
  if (!exactlyTheStall(secret, expected.stallPubkey)) return 'no-stall-co-key'

  const voucher = parsed.voucher
  if (voucher.issuerId.toLowerCase() !== expected.stallPubkey) return 'wrong-issuer'
  if (!verifyVoucher(voucher).signatureValid) return 'bad-signature'

  const metadata = parseTerminalMetadata(voucher.merchantMetadata)
  if (
    !metadata ||
    metadata.stall_pubkey !== expected.stallPubkey ||
    metadata.lock_key !== expected.lockedTo ||
    metadata.role !== expected.role
  ) {
    return 'metadata-mismatch'
  }

  return null
}

/** NUT-11 tags that add a spending path beyond `data` and `pubkeys`. */
const EXTRA_PATH_TAGS = ['refund', 'locktime', 'n_sigs_refund']

/**
 * The secret's NUT-11 `pubkeys` tag is exactly `[stall]`, `n_sigs` is 1 (or
 * absent), and there is no refund or locktime path.
 */
function exactlyTheStall(secret: string, stall: string): boolean {
  try {
    const body = (JSON.parse(secret) as [string, { tags?: unknown }])[1]
    const tags = Array.isArray(body?.tags) ? (body.tags as unknown[]) : []
    const rows = tags.filter((t): t is unknown[] => Array.isArray(t))
    if (rows.some((t) => EXTRA_PATH_TAGS.includes(String(t[0])))) return false
    const nSigs = rows.filter((t) => t[0] === 'n_sigs')
    if (nSigs.length > 1 || (nSigs.length === 1 && String(nSigs[0][1]) !== '1')) return false
    const pubkeys = rows.filter((t) => t[0] === 'pubkeys')
    if (pubkeys.length !== 1) return false
    const listed = pubkeys[0].slice(1)
    return (
      listed.length === 1 && typeof listed[0] === 'string' && xOnly(listed[0]).toLowerCase() === stall
    )
  } catch {
    return false
  }
}

/** What the owner is told, per defect. Plain, and says nothing was left live where true. */
const DEFECT_MESSAGE: Record<CredentialDefect, string> = {
  unreadable: 'The terminal’s authority came back unreadable.',
  'not-locked': 'The terminal’s authority came back unlocked.',
  'wrong-lock': 'The terminal’s authority came back locked to a different device.',
  'no-stall-co-key': 'The terminal’s authority came back without a way for you to revoke it.',
  'wrong-issuer': 'The terminal’s authority came back for a different stall.',
  'bad-signature': 'The terminal’s authority came back with a signature that does not check out.',
  'metadata-mismatch': 'The terminal’s authority came back describing a different terminal.',
}

export class CredentialMintError extends Error {
  constructor(
    message: string,
    readonly defect?: CredentialDefect,
    /** The gateway's HTTP status when it refused the request outright. */
    readonly status?: number,
    /** A defective credential whose cancelling spend did not land, so it must be kept. */
    readonly unspentToken?: string,
  ) {
    super(message)
    this.name = 'CredentialMintError'
  }
}

/** What the caller learns while a mint is in flight, so it can persist each step. */
export interface MintProgress {
  /**
   * Sent with the request as `Idempotency-Key`. The caller persists it BEFORE
   * calling, so a request whose answer was lost can be sent again and the
   * gateway replays the same credential rather than minting a second one.
   */
  idempotencyKey?: string
  /** Called as soon as the gateway names the voucher, before the token is polled for. */
  onAccepted?: (voucherId: string) => void
}

/**
 * Mint a terminal's credential from the owner's phone, and keep it only if it is right.
 *
 * @param spendAtOnce spends a defective credential with the stall's key. Called before the
 *   error is thrown, so a bad credential is never left live. Its own failure is reported in
 *   the message, not swallowed: an owner must know if something is still out there.
 */
export async function mintTerminalCredential(
  credential: PreparedCredential,
  spendAtOnce: (token: string) => Promise<boolean>,
  transport: MintTransport = ownerTransport,
  progress: MintProgress = {},
): Promise<MintedCredential> {
  const created = await transport.post(
    '/api/v1/wallet/vouchers',
    credentialRequestBody(credential),
    progress.idempotencyKey ? { 'Idempotency-Key': progress.idempotencyKey } : undefined,
  )
  if (!created.ok) {
    throw new CredentialMintError(await refusal(created), undefined, created.status)
  }
  const { voucher_id: voucherId } = (await created.json()) as { voucher_id?: string }
  if (!voucherId) throw new CredentialMintError('The gateway minted nothing.')
  progress.onAccepted?.(voucherId)

  return checkMinted(credential, voucherId, spendAtOnce, transport)
}

/**
 * Fetch a credential the gateway has accepted, check it, and spend it if it is wrong.
 *
 * Split out so a mint whose answer arrived but whose token did not can be resumed later
 * from the voucher id alone (`resumeMinting`).
 */
export async function checkMinted(
  credential: PreparedCredential,
  voucherId: string,
  spendAtOnce: (token: string) => Promise<boolean>,
  transport: MintTransport = ownerTransport,
): Promise<MintedCredential> {
  const token = await waitForToken(voucherId, transport)

  const defect = credentialDefect(token, credential)
  if (defect) {
    const spent = await spendAtOnce(token).catch(() => false)
    throw new CredentialMintError(
      `${DEFECT_MESSAGE[defect]} ${
        spent
          ? 'It has been cancelled, and nothing was set up.'
          : 'It could not be cancelled yet. It stays on your list and is cancelled the next ' +
            'time you open Terminals with a connection.'
      }`,
      defect,
      undefined,
      spent ? undefined : token,
    )
  }

  return { voucherId, token, expiresAt: parseVoucherToken(token).voucher.expiresAt }
}

async function waitForToken(voucherId: string, transport: MintTransport): Promise<string> {
  const deadline = Date.now() + TOKEN_WAIT_MS
  let status = 'unknown'
  for (;;) {
    const response = await transport.get(`/api/v1/wallet/vouchers/${encodeURIComponent(voucherId)}`)
    if (response.ok) {
      const body = (await response.json()) as { status?: string; token?: string }
      status = body.status ?? status
      if (body.token && body.status === 'ISSUED') return body.token.trim()
    }
    if (Date.now() >= deadline) break
    await transport.sleep(TOKEN_POLL_MS)
  }
  throw new CredentialMintError(
    `The terminal’s authority was not ready in time (status ${status}). It stays on your list ` +
      'and is picked up the next time you open Terminals.',
  )
}

async function refusal(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    if (body.error?.message) return `Could not set up the terminal: ${body.error.message}`
  } catch {
    // Not JSON. The status is the best we have.
  }
  return `Could not set up the terminal (${response.status}).`
}

/**
 * The six-digit check code both screens show, so the operator can confirm the device got
 * THIS stall's credential and not one an onlooker sent to its public key (spec 4.2).
 *
 * `sha256(utf8(voucherId + stallPubkey + terminalPubkey))`, all lowercase hex or UUID text,
 * read as a big-endian integer, mod 10^6, zero-padded to six digits.
 *
 * The code alone is NOT a grinding bound: an attacker can self-sign a fake credential with a
 * `voucherId` of their choosing, so matching six digits offline takes milliseconds (#160
 * review). What stops a hijack is that the device also requires the offer to come from the
 * stall its setup code names (phase 2). The code then confirms the operator is looking at the
 * same credential as the owner, not that nobody else could produce those digits.
 */
export function checkCode(voucherId: string, stallPubkey: string, terminalPubkey: string): string {
  const digest = sha256(
    utf8ToBytes(voucherId.toLowerCase() + stallPubkey.toLowerCase() + terminalPubkey.toLowerCase()),
  )
  return (BigInt('0x' + bytesToHex(digest)) % 1_000_000n).toString().padStart(6, '0')
}

/** `482913` → `482 913`, as both screens show it. */
export function formatCheckCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}
