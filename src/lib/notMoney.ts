import type { VoucherRow } from '@imani/wallet-storage'

import { parseTerminalMetadata, type TerminalMetadata } from './terminalCredential'
import { parseVoucherToken, tokenProofs, verifyVoucher } from './voucherToken'

/**
 * The x-only key a P2PK_VOUCHER secret's `data` locks to. Read here rather than through
 * `witness.ts`, which pulls the session signer in with it: this runs inside `spendable`, on every
 * screen, and must not need a session.
 */
function lockOf(secret: string): string | null {
  try {
    const [kind, body] = JSON.parse(secret) as [unknown, { data?: unknown }]
    if (kind !== 'P2PK_VOUCHER' && kind !== 'P2PK') return null
    const data = body?.data
    if (typeof data !== 'string') return null
    return (data.length === 66 ? data.slice(2) : data).toLowerCase()
  } catch {
    return null
  }
}

/**
 * Is this token a terminal credential rather than money? (#160, the 1-sat credential in a balance)
 *
 * A terminal credential is a one-sat voucher whose SIGNED `merchant_metadata` marks it as one
 * (`terminalMetadataJson`). It is authority for a till, never value, so it must not reach a
 * balance, the home carousel, coin selection or a "Payment received" toast.
 *
 * ## Classified from verified, signed bytes only
 *
 * Hiding a row from the balance is the dangerous direction: a recogniser a sender could satisfy
 * would let anyone make real money vanish from a wallet. So every condition below is a fact the
 * issuer signed or the mint enforces, and all must hold:
 *
 * - the voucher's issuer signature verifies over the metadata;
 * - the metadata parses as a terminal credential (`terminal === true`, a role, a stall, a lock);
 * - the token is ONE proof, locked, and the mint's lock is the metadata's `lock_key`;
 * - it is worth at most `CREDENTIAL_MAX_SATS`, as every credential is minted
 *   (`terminalMint.credentialRequestBody`: one sat). A valuable voucher that merely CLAIMS to be
 *   a credential therefore stays money, which is the safe way to be wrong.
 *
 * Nothing on the DM envelope or the stored row's own fields is read: those are sender-written.
 */

/** The face value every terminal credential is minted at, in sats. */
export const CREDENTIAL_MAX_SATS = 1

/** The credential's signed metadata, or null when the token is anything else. Never throws. */
export function terminalCredentialFromToken(token: string | undefined | null): TerminalMetadata | null {
  if (!token) return null
  try {
    const proofs = tokenProofs(token)
    if (proofs.length !== 1) return null
    const parsed = parseVoucherToken(token)
    if (parsed.tokenAmount > CREDENTIAL_MAX_SATS) return null
    const voucher = parsed.voucher
    if (Number(voucher.faceValue) > CREDENTIAL_MAX_SATS || String(voucher.unit).toLowerCase() !== 'sat') return null
    const metadata = parseTerminalMetadata(voucher.merchantMetadata)
    if (!metadata) return null
    if (lockOf(proofs[0].secret) !== metadata.lock_key) return null
    if (!verifyVoucher(voucher).signatureValid) return null
    return metadata
  } catch {
    return null
  }
}

/**
 * Parsed answers keyed by the content-derived `token_id`, as `licences.ts` keeps them: `spendable`
 * runs over every row on every render, and the same id is byte-identical input.
 */
const byTokenId = new Map<string, boolean>()

/** Is this stored row a terminal credential? */
export function isTerminalCredential(row: Pick<VoucherRow, 'token' | 'token_id'>): boolean {
  const id = row.token_id
  if (!id) return terminalCredentialFromToken(row.token) !== null
  const cached = byTokenId.get(id)
  if (cached !== undefined) return cached
  const answer = terminalCredentialFromToken(row.token) !== null
  byTokenId.set(id, answer)
  return answer
}

/** Drop the parse cache. For tests. */
export function forgetCredentialParses(): void {
  byTokenId.clear()
}
