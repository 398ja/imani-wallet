/**
 * Every word the customer's voucher row says (the list row and what it opens to). One module, as
 * `cashlinkCopy.ts` is, so the wording lives in one place and a translation has one file to read.
 *
 * The row replaced the voucher detail screen. It shows only what a holder acts on: what it is
 * worth, whether it can still be spent, when it arrived and runs out, where it came from, and an
 * id to quote to support. The backing, the ratio, the issuance id, the event id and the like were
 * on that screen and confused people. They are not shown anywhere now, and stay in the support
 * snapshot (`snapshot/build.ts`, `voucherRow`), which is where they are useful.
 */

/** Labels in the opened row. */
export const VOUCHER_FIELD = {
  status: 'Status',
  received: 'Received',
  expires: 'Expires',
  source: 'From',
  id: 'Voucher id',
} as const

/** What a row's status badge says. Keyed by what the row IS, not the raw stored word. */
export const VOUCHER_STATUS = {
  active: 'Ready to use',
  pending: 'Pending',
  spent: 'Spent',
  redeemed: 'Redeemed',
  expired: 'Expired',
  swapped: 'Swapped back',
  refused: 'Redeemed in full',
  other: 'Unavailable',
} as const

export type VoucherStatusKind = keyof typeof VOUCHER_STATUS

/**
 * Where a voucher came from, in the holder's words. Keyed by `source_transport`. Absent or unknown
 * transports say "Received": true of every voucher, and never a protocol word.
 */
export const VOUCHER_SOURCE = {
  cashlink: 'Cashlink',
  returned: 'Cashlink you sent, back to you',
  bought: 'Bought',
  recovered: 'Recovered',
  received: 'Received',
} as const

export type VoucherSourceKind = keyof typeof VOUCHER_SOURCE

export function voucherSourceKind(transport: unknown): VoucherSourceKind {
  switch (transport) {
    case 'cashback':
    case 'gift_link':
      return 'cashlink'
    case 'gift_link_reclaim':
      return 'returned'
    case 'client_mint':
    case 'gateway_mint':
      return 'bought'
    case 'escrow_recovery':
      return 'recovered'
    default:
      return 'received'
  }
}

export const NO_EXPIRY = 'No expiry'
export const expiredOn = (date: string) => `Expired on ${date}`
export const expiredShort = (date: string) => `Expired ${date}`
export const COPY_ID = 'Copy voucher id'
export const COPIED = 'Copied'
export const SHOW_DETAILS = 'Show details'
export const HIDE_DETAILS = 'Hide details'
export const NO_LONGER_HELD = 'This voucher is no longer in your wallet.'
export const BACK_HOME = 'Back to Home'
