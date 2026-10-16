import { Link } from 'react-router-dom'
import { CheckCircle2, XCircle } from 'lucide-react'

import { Screen, buttonClasses } from '../components/ui'
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

/**
 * Both pages are a full-page arrival from Stripe, so each states the outcome
 * once (`role="status"`, announced on load) and offers a way on AND a way back:
 * the buyer came from a stall, and a page whose only exit is the wallet home
 * leaves them nowhere near it. The main action is the house `Button` look, so
 * it reads as the same control the Buy screen used a minute ago.
 */
export function BuyDonePage() {
  const stall = rememberedStall()
  const { branding } = useBranding(stall)
  const name = branding?.organizationName
  return (
    <Screen>
      <div className="flex flex-col items-center pt-16 text-center">
        <div role="status" className="flex flex-col items-center">
          <CheckCircle2 className="mb-4 h-12 w-12 text-green-600 dark:text-green-500" aria-hidden />
          <h1 className="mb-2 text-title font-semibold">Payment received</h1>
          <p className="mb-8 text-callout text-mono-500">
            {name ? `Your voucher from ${name} is on its way.` : 'Your voucher is on its way.'} It
            usually arrives in your wallet within a minute.
          </p>
        </div>
        <Link to="/" className={`${buttonClasses('primary', 'lg')} w-full`}>
          Go to my vouchers
        </Link>
        {stall && (
          <Link to={`/merchants/${stall}`} className={`${buttonClasses('ghost', 'lg')} mt-2 w-full`}>
            Back to the stall
          </Link>
        )}
      </div>
    </Screen>
  )
}

export function BuyCancelledPage() {
  const stall = rememberedStall()
  return (
    <Screen>
      <div className="flex flex-col items-center pt-16 text-center">
        <div role="status" className="flex flex-col items-center">
          <XCircle className="mb-4 h-12 w-12 text-mono-400" aria-hidden />
          <h1 className="mb-2 text-title font-semibold">Payment cancelled, nothing was charged</h1>
          <p className="mb-8 text-callout text-mono-500">You can try again whenever you like.</p>
        </div>
        <Link to={stall ? `/buy/${stall}` : '/'} className={`${buttonClasses('primary', 'lg')} w-full`}>
          {stall ? 'Try again' : 'Back to my wallet'}
        </Link>
        {stall && (
          <Link to="/" className={`${buttonClasses('ghost', 'lg')} mt-2 w-full`}>
            Back to my wallet
          </Link>
        )}
      </div>
    </Screen>
  )
}
