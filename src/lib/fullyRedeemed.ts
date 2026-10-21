/**
 * The mint's redemption cap said no: this coupon is redeemed in full (cashu-mint#540).
 *
 * ## Where it comes from
 *
 * A redeemer (gateway-core paying a stall's request, gateway-customer taking a coupon home)
 * declares each credit to the mint. When a coupon's declared credits would pass the sats
 * issued for it, the mint refuses with `voucher_not_accepted` (90025) and the redeemer answers
 * `VOUCHER_FULLY_REDEEMED`: on an atomic send as the FAILED status's `error_code`, on a receive
 * as the 400's `error.code`.
 *
 * ## What it means for the holder
 *
 * The mint signed nothing and released its hold, so **the holder's proofs are untouched**. The
 * coupon is not lost, but it cannot be spent as a coupon: every retry is refused the same way.
 * So it is terminal, never retried, and the holder is offered "Swap back to sats"
 * (`swapBack.ts`), which turns the proofs into plain sats without claiming the coupon.
 *
 * Someone else most likely redeemed a copy of this coupon. Support is keyed on the reference,
 * the voucher id's first 8 characters, which is also what the mint's alert carries.
 */

/** The code both gateways answer with. A stable contract: matched on, never on wording. */
export const VOUCHER_FULLY_REDEEMED = 'VOUCHER_FULLY_REDEEMED'

/** The row status a coupon refused this way is marked with: held, but not spendable as a coupon. */
export const FULLY_REDEEMED_STATUS = 'fully_redeemed'

/** The voucher id's first 8 characters, the reference the holder quotes to the stall. */
export function couponReference(voucherId: string | undefined | null): string {
  return (voucherId ?? '').slice(0, 8)
}

/** The holder-facing text (design §2.13). */
export function fullyRedeemedMessage(voucherId: string | undefined | null, stallName?: string): string {
  const stall = stallName?.trim() ? stallName.trim() : 'the stall'
  return (
    'This coupon has already been redeemed in full. If you believe this is wrong, contact ' +
    `${stall}, quoting reference ${couponReference(voucherId)}.`
  )
}

/** Whether a gateway answer (an error or a send status) is the 90025 refusal. */
export function isVoucherFullyRedeemed(answer: unknown): boolean {
  if (!answer || typeof answer !== 'object') return false
  const a = answer as {
    code?: unknown
    error_code?: unknown
    data?: { code?: unknown; error?: { code?: unknown } }
  }
  return (
    a.code === VOUCHER_FULLY_REDEEMED ||
    a.error_code === VOUCHER_FULLY_REDEEMED ||
    a.data?.code === VOUCHER_FULLY_REDEEMED ||
    a.data?.error?.code === VOUCHER_FULLY_REDEEMED
  )
}

/**
 * A payment or send refused because the coupon is redeemed in full. Terminal: the screen shows
 * {@link message} and offers "Swap back to sats" for {@link tokenId}.
 */
export class VoucherFullyRedeemedError extends Error {
  readonly code = VOUCHER_FULLY_REDEEMED
  readonly terminal = true

  constructor(
    readonly voucherId: string | undefined,
    /** The local row of the refused coupon, still holding its proofs. */
    readonly tokenId: string,
    stallName?: string,
  ) {
    super(fullyRedeemedMessage(voucherId, stallName))
    this.name = 'VoucherFullyRedeemedError'
  }

  get reference(): string {
    return couponReference(this.voucherId)
  }
}
