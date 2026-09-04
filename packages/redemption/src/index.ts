/**
 * The redemption ceiling: how much of a voucher is left to give.
 *
 * A signature says a voucher is genuine. A face value bounds any single
 * presentation. Neither notices the same £10 voucher being presented four times
 * for £10 — and a partially-spent voucher legitimately comes back more than
 * once, so the bound has to be on the SUM rather than the count.
 *
 * ## Why this is a package
 *
 * The app's `checkRedemption` reads `listTransactions()` itself and reaches
 * IndexedDB through `wallet.ts`. That is correct for a till — a merchant who
 * accepted a redemption with no signal must be able to enforce their own
 * ceiling without asking anyone — and it makes the check impossible to call
 * from a service that stores nothing.
 *
 * So the arithmetic moves here, taking prior redemptions as an ARGUMENT, and
 * both callers use it: the app passes rows it reads from storage, the API
 * passes rows the caller sent.
 *
 * ## The risk this file carries
 *
 * A copy that drifts from the app's would leave a till and an API enforcing
 * different ceilings on the same voucher, each internally consistent, and no
 * test failing. That is why `redemptionLedger.ts` calls this rather than
 * matching it, and why `attestShapeParity.test.ts` exists.
 *
 * ## What this deliberately does not do
 *
 * It does not read storage, a clock, or a network. It does not decide whether
 * the voucher is genuine — that is the signature's job, upstream — and it does
 * not choose the ceiling: `signedFaceValue` must come from the verified
 * voucher, because a ceiling the caller chose is not a ceiling.
 */

export type { PriorRedemption, RedemptionCheck, CeilingInput } from './types.js'
export { checkCeiling, redeemedTotalOf } from './ceiling.js'
