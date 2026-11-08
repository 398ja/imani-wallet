/**
 * What the wallet checked about a cashback coupon (#156).
 *
 * Every other receive path records a `validation` on the row it writes, and the
 * detail screen reads it. Cashback never did: `commitToken` redeemed with
 * `source: 'cashback'`, which skips the inspect-before-save gate, and nothing
 * else ran the issuer and signature check. So every cashback coupon read
 * "Issuer: Not checked", including perfectly genuine ones.
 *
 * ## Recorded, not refused
 *
 * `dmCrypto` refuses a voucher whose signature fails, because a DM is retried
 * and its sender is a stranger. Here the token came from the gateway after a
 * destructive one-shot claim: refusing it would throw away value nobody can
 * hand back. So a failure is RECORDED, and the badge says so, which is the
 * thing the issue is about. Silence must never read as a pass, and a failed
 * check must never read as silence.
 *
 * Recording is still not attesting. See the comment in `commitToken`.
 */
import { checkIssuer } from './issuerAllowlist'
import { buildValidationRecord } from './voucherValidationRecord'
import {
  isUnverifiableVoucherError,
  isVoucherSecret,
  parseVoucherToken,
  proofSecrets,
  verifyVoucher,
  type VoucherValidation,
} from './voucherToken'

/**
 * The validation record for a token, or undefined for plain ecash (which makes
 * no issuer claim, so there is nothing to check).
 *
 * The same checks `dmCrypto.verifiedVoucherFrom` makes, minus mint and unit
 * trust (see below), and the record is built by the same
 * `buildValidationRecord`, so a cashback row and a DM row read identically.
 *
 * An issuer key outside a configured allowlist is recorded as a failed
 * signature check. `VoucherValidation` has no separate issuer field, and the
 * other honest options (verified, unchecked) would both be lies.
 *
 * Mint and unit are not checked. In `dmCrypto` that check is a refusal gate
 * with no field on the record, so there is nothing for it to write here, and
 * the token was minted by this deployment's own gateway for this customer.
 *
 * Never throws. It runs after the destructive claim, so an exception here would
 * strand the token in the replay stash; anything unexpected is recorded as a
 * failed check rather than allowed to abort the redeem.
 */
export function cashbackValidation(token: string): VoucherValidation | undefined {
  try {
    return check(token)
  } catch (error) {
    console.warn('[cashback] coupon check threw; recording it as failed', error)
    return UNREADABLE
  }
}

/** A coupon whose voucher could not be read. Fails, never reads as silence. */
const UNREADABLE: VoucherValidation = {
  signatureValid: false,
  legacyCanonical: false,
  signedFaceValue: 0,
  cappedAtFaceValue: false,
}

function check(token: string): VoucherValidation | undefined {
  let parsed: ReturnType<typeof parseVoucherToken>
  try {
    parsed = parseVoucherToken(token)
  } catch (e) {
    // A by-reference voucher with a missing document or an invalid document map is a coupon that
    // cannot be verified (cashu-voucher#64). An invalid map also makes `proofSecrets` throw below,
    // which would read as plain ecash, so it is answered first.
    if (isUnverifiableVoucherError(e)) {
      console.warn('[cashback] by-reference coupon cannot be verified')
      return { ...UNREADABLE }
    }
    // Plain ecash makes no issuer claim. But a token whose proofs DO carry a
    // voucher that cannot be read (a missing or malformed signature) is a
    // coupon that failed its check, and must not fall through to silence.
    let carriesVoucher = false
    try {
      carriesVoucher = proofSecrets(token).some(isVoucherSecret)
    } catch (inner) {
      // Unverifiable on its own terms (review N9), not "plain ecash", whatever the outer parse said.
      if (isUnverifiableVoucherError(inner)) return { ...UNREADABLE }
      carriesVoucher = false
    }
    if (!carriesVoucher) return undefined
    console.warn('[cashback] coupon carries a voucher that could not be read')
    return { ...UNREADABLE }
  }

  const verification = verifyVoucher(parsed.voucher)
  const issuerKnown = checkIssuer(parsed) !== 'unknown-issuer'
  const signatureValid = verification.signatureValid && issuerKnown
  if (!signatureValid) {
    console.warn(
      '[cashback] coupon did not verify:',
      parsed.voucher.voucherId,
      verification.signatureValid ? 'unrecognised issuer key' : 'bad signature',
    )
  }

  const { record, warrantRefusal } = buildValidationRecord(parsed, {
    signatureValid,
    legacyCanonical: verification.legacyCanonical,
  })
  if (warrantRefusal !== undefined) {
    console.warn('[cashback] issuance warrant refused:', parsed.voucher.voucherId, warrantRefusal)
  }
  return record
}

/** Storage, passed in so the re-check can be tested without IndexedDB. */
export interface RecheckPorts {
  getTransaction: (id: string) => Promise<Record<string, unknown> | null>
  getVoucher: (tokenId: string) => Promise<{ token?: string; source_transport?: string } | null>
  updateTransaction: (id: string, patch: Record<string, unknown>) => Promise<unknown>
}

/**
 * Re-check a row saved before #156, when it is opened.
 *
 * Only an incoming row with NO validation, whose coupon arrived by cashback.
 * Rows from other paths that read "Not checked" are left as they are: their
 * absence predates verification for reasons this fix does not touch, and a
 * row that already carries a result keeps its own.
 *
 * Returns true when it wrote a validation. Never throws: this is a display
 * repair, and failing it leaves the row exactly as it was.
 */
export async function recheckCashbackRow(id: string, ports: RecheckPorts): Promise<boolean> {
  try {
    const row = await ports.getTransaction(id)
    if (!row || row.direction !== 'in' || row.validation) return false
    const tokenId = (row.tokenId ?? row.token_id) as string | undefined
    if (!tokenId) return false
    const voucher = await ports.getVoucher(tokenId)
    if (!voucher?.token || voucher.source_transport !== 'cashback') return false
    const validation = cashbackValidation(voucher.token)
    if (!validation) return false
    await ports.updateTransaction(id, { validation })
    return true
  } catch (error) {
    console.error('[cashback] re-check failed', error)
    return false
  }
}
