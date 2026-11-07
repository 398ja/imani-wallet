import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Screen } from './ui'

/**
 * The line under the greyed-out buttons of a closed stall (#434). Amber, like NotTrading: closing
 * is a choice the owner made, not a fault.
 */
export function ClosedNote({ owner }: { owner: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-4 rounded-2xl bg-amber-50 p-4 text-center text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
    >
      <p className="font-medium">Closed for business</p>
      <p className="mt-1">
        {owner ? (
          <>
            Selling and redeeming are paused here and on your terminals.{' '}
            <Link to="/settings/merchant" className="underline">
              Open again in Settings
            </Link>
            .
          </>
        ) : (
          'This stall is closed. Ask the owner to open it again.'
        )}
      </p>
    </div>
  )
}

/**
 * #558 "Close my stall": the banner while selling has stopped and redeeming goes on.
 */
export function SalesClosedNote() {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="sales-closed"
      className="mt-4 rounded-2xl bg-amber-50 p-4 text-center text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
    >
      <p className="font-medium">Your stall is closed for selling</p>
      <p className="mt-1">
        You can no longer sell vouchers here, on your terminals or by card. Customers can still spend the
        vouchers they hold with you, so keep redeeming them.
      </p>
    </div>
  )
}

/** Guards Sell and Cashback for a stall closed for selling (#558). Redeem is never wrapped. */
export function SellingStallOnly({ merchant, children }: { merchant: { salesClosed?: boolean }; children: ReactNode }) {
  if (merchant.salesClosed !== true) return <>{children}</>
  return (
    <Screen>
      <div className="flex min-h-[calc(100svh-9rem)] flex-col justify-center">
        <SalesClosedNote />
      </div>
    </Screen>
  )
}

/**
 * Guards a trading screen (Sell, Cashback, Redeem) on the stall being OPEN (#434). The routes stay
 * mounted for a closed stall, so a typed URL or a stale tab lands on an explanation rather than a
 * customer screen or a 404, and nothing on the screen behind can move money.
 */
export function OpenStallOnly({
  merchant,
  owner = true,
  children,
}: {
  merchant: { active: boolean }
  owner?: boolean
  children: ReactNode
}) {
  if (merchant.active) return <>{children}</>
  return (
    <Screen>
      <div className="flex min-h-[calc(100svh-9rem)] flex-col justify-center">
        <ClosedNote owner={owner} />
      </div>
    </Screen>
  )
}
