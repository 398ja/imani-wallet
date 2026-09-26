/**
 * What a redemption row must say for the stall's books to count it (#90).
 *
 * ## The defect this closes
 *
 * `issuedVoucher` sums a voucher's claims as incoming rows carrying the SAME
 * `voucherId` as the issuance, and `redemptionLedger` enforces the ceiling off
 * the same rows. The redemption row is written, but not by anything that knows
 * the voucher's id: `tokenRedemption.buildVoucher` takes it from the gateway's
 * receive response (`result.voucher_id || result.id || crypto.randomUUID()`),
 * and `ReceiveResponse` carries neither field. So every redemption landed under
 * a random id, the claimed figure sat at zero, outstanding stayed at the full
 * face, and the ceiling never saw a prior redemption. Nothing failed; the sum
 * ran over an empty set.
 *
 * ## What is stamped, and only when
 *
 * The signed voucher's own id, face value, unit and decimals, which dmCrypto
 * puts on `meta` from the verified voucher. `faceValue` is the value of THIS
 * token (clamped to the signed face), so a partial redemption records the
 * partial amount and the next one adds to it.
 *
 * Two gates, both load-bearing:
 *
 *  - **Signature verified.** Otherwise every one of these fields is whatever
 *    the sender wrote in the envelope, and a sender could file a coupon against
 *    any voucher of their choosing, in either direction.
 *  - **The receiver is the issuer.** A claim is a coupon coming HOME. A customer
 *    holding someone else's voucher can legitimately receive the same value
 *    more than once (A pays B, B pays A back), and stamping the id there would
 *    switch the ceiling on for them and refuse an honest transfer. Their rows
 *    keep the builder's id, as before.
 *
 * ## Why a local row and not the kind-7377 attestations
 *
 * The attestations are public, so they carry neither the stall nor the amount
 * in the clear, and reading them back means a relay round trip on a till that
 * must enforce its ceiling with no signal. The row is also not device-local:
 * `wallet.backUpWrites` publishes every row written through `atomicallyWrite`
 * as a sealed kind-7376 record, `voucher_id` and `face_value` included, and
 * `restoreTx` reads them back. So the figure survives a restore without making
 * the attestations a second source of truth.
 */
import type { VoucherValidation } from './voucherToken'

/** What `stampCorrelation` overwrites on the redemption row. */
export interface MerchantClaim {
  voucherId: string
  amount: number
  unit: string
  decimals?: number
}

/**
 * The claim to file for this redemption, or undefined when there is none.
 *
 * `meta` is dmCrypto's metadata; `stallPubkey` is the receiving wallet's key.
 */
export function merchantClaimFor(
  meta: Record<string, unknown> | undefined,
  stallPubkey: string | undefined,
): MerchantClaim | undefined {
  const validation = meta?.validation as VoucherValidation | undefined
  if (validation?.signatureValid !== true) return undefined

  const issuerId = typeof meta?.issuerId === 'string' ? meta.issuerId : ''
  if (!stallPubkey || !issuerId || issuerId.toLowerCase() !== stallPubkey.toLowerCase()) {
    return undefined
  }

  const voucherId = typeof meta?.voucherId === 'string' ? meta.voucherId : ''
  const amount = Number(meta?.faceValue)
  const unit = typeof meta?.faceUnit === 'string' ? meta.faceUnit.toUpperCase() : ''
  if (!voucherId || !unit || !Number.isFinite(amount) || amount <= 0) return undefined

  const decimals = Number(meta?.faceDecimals)
  return { voucherId, amount, unit, decimals: Number.isFinite(decimals) ? decimals : undefined }
}
