/**
 * A movement, as a report needs to see it.
 *
 * A structural subset of the app's `WalletTransaction`, declared here rather
 * than imported so this package does not depend on `src/lib` — which would
 * defeat the point of extracting it, since the wallet API cannot import from
 * the app.
 *
 * The app's own type is wider and assignable to this, so `merchantStats(rows)`
 * still typechecks at every existing call site with no change.
 */
export interface ReportTransaction {
  id: string
  /** The writer's vocabulary: 'issued' | 'received' | 'payment' | 'sent' | 'redeemed'. */
  type: string
  /**
   * Derived from `type` by whoever built this row, never read off storage.
   *
   * `toTransaction` is the app's one place that derives it, because the stored
   * rows disagree with themselves. A caller sending this over HTTP is trusted
   * with it only as far as the report goes — no money moves on a report.
   */
  direction: 'in' | 'out'
  /** Epoch milliseconds. */
  at: number
  amount: number
  unit: string
  decimals: number
  merchantId?: string
  voucherId?: string
  counterparty?: string
  expiresAt?: number
  /**
   * The parts of one logical send, when a payment arrived split across several
   * coupons. `groupArrivals` sums them, because a customer paying £10 as three
   * coupons has paid once and a merchant must see one arrival.
   */
  bundleId?: string
  /**
   * The NUT-18V payment request this settles, when it settles one.
   *
   * With it, a request settles BY ID rather than by guessing from the amount —
   * which is what stops two similar requests being confused.
   */
  paymentId?: string
}
