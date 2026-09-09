/**
 * A stall's own numbers, from its own rows.
 *
 * NOT from the gateway's dashboard endpoint. That one exists and answers 200,
 * and it answers with zeros: it is fed by sources that deliberately do not
 * consult customer-wallet, so a merchant who has issued three coupons is told
 * `vouchers_issued: 0`. Rendering that would be a dashboard of lies, and the
 * issuance rows in a wallet are the only honest record of those coupons.
 *
 * ## Why a package
 *
 * The wallet API answers `/v1/reports/*` over rows a caller supplies, and it
 * cannot import from `src/lib`. Extracting this is what stops the API growing
 * a second implementation of the same arithmetic — which would be worse than
 * useless, since two dashboards disagreeing about takings is indistinguishable
 * from money going missing.
 *
 * Pure functions of their arguments throughout: no storage, no clock, no DOM.
 * The caller supplies `now`, which is what makes a window testable to the
 * millisecond.
 */
export type { ReportTransaction } from './types.js'
export type { MerchantStats } from './stats.js'
export { merchantStats, outstandingLiability, expiringSoon } from './stats.js'
