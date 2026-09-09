/**
 * Asking to be paid.
 *
 * The rules a till and the wallet API must agree on: when a request has
 * expired, which arrival settles which request, and how much of one is still
 * outstanding. Pure functions throughout, so the same question asked of the
 * app's storage and of an API request body cannot get two answers.
 */
export type { VoucherPaymentRequest, Arrival } from './requests.js'
export { expireRequests, matchPayment, groupArrivals, partialFor } from './requests.js'
