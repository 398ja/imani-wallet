/**
 * One prior movement against a voucher.
 *
 * Deliberately not the app's `TransactionRow`. That type carries a dozen fields
 * this arithmetic must not see, and depending on it would drag storage's shape
 * into a package whose whole point is not having one — and into an API request
 * body, where every extra field is something a caller could lie about to no
 * effect.
 */
export interface PriorRedemption {
  /**
   * Face minor units taken in on this movement.
   *
   * Minor units throughout: a coupon carries cents, not euros, and mixing the
   * two silently multiplies a ceiling by a hundred.
   */
  amount: number
  /**
   * Whether value came IN to the holder of this ledger, or went out.
   *
   * Load-bearing, and the single easiest thing to get wrong. A merchant
   * ISSUING a voucher writes an OUTGOING row against the same `voucherId`, and
   * counting it would consume the entire ceiling before a customer ever
   * redeemed anything. The app derives this through `toTransaction` precisely
   * because its stored rows disagree with themselves about direction.
   */
  direction: 'in' | 'out'
}

export interface CeilingInput {
  /**
   * The issuer-signed face value, in minor units.
   *
   * Must come from the VERIFIED voucher. A caller-supplied value is not a
   * ceiling, it is a suggestion, and the whole check collapses to whatever the
   * presenter felt like claiming.
   */
  signedFaceValue: number
  /** What this presentation is asking to take, in minor units. */
  requested: number
  /**
   * Everything already taken against this voucher, as the CALLER knows it.
   *
   * The honest limit of this check, and it belongs in the type rather than in
   * a paragraph someone might not read: the answer is only as good as the
   * history supplied. A caller that omits rows gets a ceiling that is too
   * generous, and no amount of arithmetic here can detect that.
   */
  priorRedemptions: PriorRedemption[]
}

export interface RedemptionCheck {
  /** False when crediting `requested` would take the voucher past what was issued. */
  allowed: boolean
  /** Sum of prior INCOMING movements against this voucher. */
  alreadyRedeemed: number
  requested: number
  /** The issuer-signed ceiling, echoed back so a caller can show its working. */
  signedFaceValue: number
  /** What remains creditable. Never negative. */
  remaining: number
}
