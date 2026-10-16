import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CreditCard } from 'lucide-react'

import { Button, Screen, BackLink, Centered, buttonClasses } from '../components/ui'
import { startPurchase } from '../lib/purchase'
import { GUEST_REFUSED, rememberPurchase } from '../lib/pendingPurchase'


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
 * nobody to ask.
 *
 * A visitor with no wallet is REFUSED for now (#267 item 2). Their coupon
 * would be delivered by Cashlink, which purchase-issuer cannot do yet, so they
 * would pay and receive nothing. payment-adapter refuses the same request
 * before creating a Checkout Session; this screen just says so first.
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
  /**
   * Only complain about what they have finished typing.
   *
   * "2" on the way to "25.00" is not an error, and a field that turns red under
   * the cursor teaches people to distrust the validation rather than the input.
   * So the message waits for something that cannot become valid by typing more.
   */
  const malformed = amount.trim() !== '' && minor === null && !/^\d*\.?\d{0,2}$/.test(amount.trim())

  const buy = async () => {
    if (minor === null) return
    setBusy(true)
    setError(null)

    // Remembered on THIS device so the return page can name the stall without
    // trusting anything Stripe puts in the URL. Before the call, so a slow
    // redirect cannot race it.
    rememberPurchase(pubkey)
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

  if (buyerPubkey === null) {
    return (
      <Screen>
        <BackLink to={`/merchants/${pubkey}`} label="Back" />
        <h1 className="mb-2 text-title font-semibold">Buy a voucher</h1>
        <p className="mb-6 text-callout text-mono-500">{GUEST_REFUSED}</p>
        <p className="mb-6 text-callout text-mono-500">
          The voucher is delivered to your wallet, so you need one before you pay. It takes
          a minute and nothing is charged.
        </p>
        <Link
          to="/"
          className={`${buttonClasses('primary', 'lg')} w-full`}
        >
          Create a wallet
        </Link>
      </Screen>
    )
  }

  return (
    <Screen>
      <BackLink to={`/merchants/${pubkey}`} label="Back" />

      {/* Tracking tightened at this size: a heading reads loose with the body
          tracking the system font ships by default. */}
      <h1 className="mb-2 text-title font-semibold">Buy a voucher</h1>
      <p className="mb-6 text-callout text-mono-500">
        You pay this stall directly by card. The voucher arrives in your wallet.
      </p>

      <label className="mb-2 block text-sm font-medium" htmlFor="amount">
        Amount
      </label>
      {/*
        `inputMode="decimal"` puts a number pad under a thumb without the
        spinners and scroll-to-change that `type="number"` brings.

        The focus ring is the app's own rather than the browser default, which
        differs per platform and would be the one control here that looks
        borrowed.
      */}
      <input
        id="amount"
        inputMode="decimal"
        autoComplete="off"
        className="mb-2 w-full rounded-xl border border-mono-200 bg-transparent px-4 py-3 text-lg tabular-nums outline-none transition-colors duration-100 ease-out placeholder:text-mono-400 focus:border-mono-400 dark:border-mono-800 dark:focus:border-mono-600"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="25.00"
        aria-describedby={malformed ? 'amount-hint' : undefined}
        aria-invalid={malformed || undefined}
      />

      {malformed && (
        <p id="amount-hint" className="mb-2 text-sm text-mono-500">
          Enter an amount like 25.00.
        </p>
      )}

      {error && (
        // `role="alert"`, like the shared `Alert`: it answers the tap the
        // customer just made, so it is announced rather than painted silently.
        <p role="alert" className="expand-row mb-4 mt-2 rounded-xl bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      )}

      {/* Disabled rather than hidden: an amount box with no button beside it
          reads as broken, and the reason it cannot be pressed is visible in the
          empty field. */}
      <Button
        size="lg"
        className="mt-4 w-full"
        disabled={minor === null}
        onClick={buy}
      >
        <CreditCard className="mr-2 h-5 w-5" aria-hidden /> Pay by card
      </Button>

      {/* A text button, not a second heavy one. Cancelling is the quiet path
          and should not compete with the thing they came here to do. */}
      <button
        type="button"
        className="pressable mt-3 inline-block py-3 text-sm text-mono-500 underline"
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
