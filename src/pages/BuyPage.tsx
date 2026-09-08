import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { CreditCard } from 'lucide-react'

import { Button, Screen, BackLink, Centered } from '../components/ui'
import { startPurchase } from '../lib/purchase'

/**
 * Buying a stall's coupon with a card.
 *
 * The customer picks an amount, taps once, and leaves for Stripe. Everything
 * that could refuse the purchase — the stall having no connected account, cards
 * not being enabled yet, no currency configured — is decided before they get
 * there, because a card form that fails after somebody has typed their number
 * is the worst place to discover a configuration problem.
 *
 * ## Where the coupon goes
 *
 * The buyer's pubkey rides on the Checkout Session, so payment confirmation
 * already names the recipient and no second lookup is needed. It is passed in
 * rather than read from a session, because this screen renders in both route
 * trees: the authenticated one knows who is buying, and the public one has
 * nobody to ask. A visitor with no wallet sends none, which is a legitimate
 * purchase — they take delivery by claim link instead.
 *
 * ## Amounts
 *
 * Typed rather than chosen from a list. A stall sells whatever it sells, and a
 * fixed ladder would be this screen guessing at a stall's prices from another
 * country.
 */
export function BuyPage({ buyerPubkey = null }: { buyerPubkey?: string | null }) {
  const { pubkey = '' } = useParams()
  const navigate = useNavigate()
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const minor = toMinorUnits(amount)

  const buy = async () => {
    if (minor === null) return
    setBusy(true)
    setError(null)

    const result = await startPurchase({
      stallPubkey: pubkey,
      amountMinor: minor,
      buyerPubkey,
    })

    if (result.kind === 'ok') {
      // A full navigation, not a router push: Stripe is another origin, and
      // this hands the customer over rather than rendering anything of theirs.
      window.location.href = result.checkoutUrl
      return
    }

    setBusy(false)
    setError(result.reason)
  }

  if (busy) return <Centered>Taking you to the payment page…</Centered>

  return (
    <Screen>
      <BackLink to={`/merchants/${pubkey}`} label="Back" />

      <h1 className="mb-2 text-xl font-semibold">Buy a voucher</h1>
      <p className="mb-6 text-sm text-mono-500">
        You pay this stall directly by card. The voucher arrives in your wallet.
      </p>

      <label className="mb-2 block text-sm font-medium" htmlFor="amount">
        Amount
      </label>
      <input
        id="amount"
        inputMode="decimal"
        className="mb-4 w-full rounded-lg border border-mono-300 px-3 py-2 dark:border-mono-700"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="25.00"
      />

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {/* Disabled rather than hidden: an amount box with no button beside it
          reads as broken, and the reason it cannot be pressed is visible in the
          empty field. */}
      <Button size="lg" className="w-full" disabled={minor === null} onClick={buy}>
        <CreditCard className="mr-2 h-5 w-5" /> Pay by card
      </Button>

      {buyerPubkey === null && (
        <p className="mt-4 text-sm text-mono-500">
          You will get a link to claim your voucher, so you can install the app
          afterwards.
        </p>
      )}

      <button
        className="mt-6 text-sm text-mono-500 underline"
        onClick={() => navigate(`/merchants/${pubkey}`)}
      >
        Cancel
      </button>
    </Screen>
  )
}

/**
 * A typed amount as minor units, or null when it is not one.
 *
 * Null rather than zero for anything unusable, so the button's disabled state
 * and the parse share one answer. Rejecting rather than rounding: a customer
 * typing "25.999" has made a mistake, and silently charging them 26.00 is a
 * worse response than not moving.
 */
function toMinorUnits(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const minor = Math.round(Number(trimmed) * 100)
  return Number.isFinite(minor) && minor > 0 ? minor : null
}
