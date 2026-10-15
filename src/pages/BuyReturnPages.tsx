import { Link } from 'react-router-dom'
import { CheckCircle2, XCircle } from 'lucide-react'

import { Screen } from '../components/ui'
import { useBranding } from '../hooks/useBranding'
import { rememberedStall } from '../lib/pendingPurchase'

/**
 * Where Stripe Checkout sends a BUYER back to (imani-wallet#267 item 3).
 *
 * Before these existed the purchase reused the deployment's global return URLs,
 * which land on the merchant's own Stripe settings screen. payment-adapter now
 * sends a purchase to `stripe.purchase-success-url`
 * (`/buy/done?session_id={CHECKOUT_SESSION_ID}`) and
 * `stripe.purchase-cancel-url` (`/buy/cancelled`).
 *
 * ## Why `session_id` is ignored
 *
 * Anyone can type `/buy/done?session_id=…`, so it is not evidence of anything:
 * it is never displayed and never used to look anything up. There is also no
 * public read endpoint for a purchase (`/api/v1/purchases` is the issuer's
 * bearer-protected queue), so this page does not poll. It states what is true
 * whatever happened at Stripe, that a voucher follows a completed payment, and
 * points to where it will appear.
 *
 * The stall is named from what THIS device remembered when the buyer left for
 * Stripe, never from the URL, and only if it is a well-formed pubkey.
 */

export function BuyDonePage() {
  const stall = rememberedStall()
  const { branding } = useBranding(stall)
  const name = branding?.organizationName
  return (
    <Screen>
      <div className="flex flex-col items-center pt-16 text-center">
        <CheckCircle2 className="mb-4 h-12 w-12 text-emerald-600" aria-hidden />
        <h1 className="mb-2 text-[22px] font-semibold tracking-[-0.02em]">Payment received</h1>
        <p className="mb-8 text-[15px] leading-relaxed text-mono-500">
          {name ? `Your voucher from ${name} is on its way.` : 'Your voucher is on its way.'} It
          usually arrives in your wallet within a minute.
        </p>
        <Link
          to="/"
          className="pressable w-full rounded-full bg-mono-900 px-6 py-3 text-center text-[17px] font-medium text-white dark:bg-mono-50 dark:text-mono-900"
        >
          Go to my vouchers
        </Link>
      </div>
    </Screen>
  )
}

export function BuyCancelledPage() {
  const stall = rememberedStall()
  return (
    <Screen>
      <div className="flex flex-col items-center pt-16 text-center">
        <XCircle className="mb-4 h-12 w-12 text-mono-400" aria-hidden />
        <h1 className="mb-2 text-[22px] font-semibold tracking-[-0.02em]">
          Payment cancelled, nothing was charged
        </h1>
        <p className="mb-8 text-[15px] leading-relaxed text-mono-500">
          You can try again whenever you like.
        </p>
        <Link
          to={stall ? `/buy/${stall}` : '/'}
          className="pressable w-full rounded-full bg-mono-900 px-6 py-3 text-center text-[17px] font-medium text-white dark:bg-mono-50 dark:text-mono-900"
        >
          {stall ? 'Try again' : 'Back to my wallet'}
        </Link>
      </div>
    </Screen>
  )
}
