/**
 * The merchant's numbers.
 *
 * Moved to `@imani/reports` so the wallet API can compute the same figures over
 * rows a caller supplies (API ticket 07). Re-exported from here because every
 * screen already imports from this path, and because a second implementation
 * would be worse than useless: two dashboards disagreeing about takings is
 * indistinguishable from money going missing.
 */
export type { MerchantStats } from '@imani/reports'
export { merchantStats, outstandingLiability, expiringSoon } from '@imani/reports'
