import { useEffect, useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CreditCard, Wallet } from 'lucide-react'

import { Button } from './ui'
import { listVouchers, onWalletChanged, walletIsOpen } from '../lib/wallet'
import { withoutInFlight } from '../lib/pay'
import { merchantActions, payPath, validVoucherCount, type ActionState } from '../lib/merchantActions'
import { rememberAfterLogin } from '../lib/afterLogin'

/**
 * Buy and Pay at one stall (#280), shared by `/merchants/:pubkey` and `/profile/:pubkey`.
 *
 * One component because the two pages had grown two copies of the Buy button
 * with two copies of its gate, and a rule that lives twice gets fixed once.
 *
 * Both buttons are ALWAYS drawn and disabled when unavailable, with the reason
 * underneath. Hiding Buy for a stall without Stripe (the old behaviour) left a
 * shopper unsure whether they had found the right screen at all; a disabled
 * button with a sentence says what the stall can and cannot do.
 */
export function MerchantActions({
  pubkey,
  acceptsCards,
  viewerPubkey,
}: {
  pubkey: string
  acceptsCards: boolean
  /** The signed-in user, or undefined for a visitor with no session. */
  viewerPubkey?: string
}) {
  const navigate = useNavigate()
  const loggedIn = viewerPubkey !== undefined
  const [valid, setValid] = useState(0)

  useEffect(() => {
    // `listVouchers` throws with no wallet open, and a visitor has nothing to
    // count anyway, so the load is skipped rather than caught.
    if (!loggedIn || !walletIsOpen()) return
    const load = async () => {
      // Minus coupons behind an unconfirmed send (#128): offering Pay on those
      // would land on SendPage's "none left" refusal.
      const rows = withoutInFlight(await listVouchers(), viewerPubkey)
      setValid(validVoucherCount(rows, pubkey))
    }
    void load()
    return onWalletChanged(() => void load())
  }, [pubkey, loggedIn, viewerPubkey])

  const { buy, pay } = merchantActions({ acceptsCards, validVouchers: valid, loggedIn })

  const onBuy = () => {
    if (loggedIn) {
      navigate(`/buy/${pubkey}`)
      return
    }
    // Guest card purchase is not supported (BuyPage refuses it), so a visitor
    // logs in first and is brought straight back to this stall's purchase
    // instead of a home screen that has forgotten why they came.
    rememberAfterLogin(`/buy/${pubkey}`)
    navigate('/login')
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <Action
        state={buy}
        label="Buy"
        accessibleName="Buy a voucher with card"
        icon={<CreditCard className="mr-2 h-5 w-5" aria-hidden />}
        onClick={onBuy}
      />
      <Action
        state={pay}
        label="Pay"
        accessibleName="Pay with your vouchers"
        icon={<Wallet className="mr-2 h-5 w-5" aria-hidden />}
        onClick={() => navigate(payPath(pubkey))}
        variant="outline"
      />
    </div>
  )
}

function Action({
  state,
  label,
  accessibleName,
  icon,
  onClick,
  variant = 'primary',
}: {
  state: ActionState
  label: string
  accessibleName: string
  icon: React.ReactNode
  onClick: () => void
  variant?: 'primary' | 'outline'
}) {
  const reasonId = useId()
  return (
    <div className="flex flex-col gap-1">
      <Button
        size="lg"
        // A disabled action drops to the quiet outline, whatever its enabled
        // variant: a solid primary fill at half opacity still reads as pressable,
        // and heavier than the disabled Pay beside it.
        variant={state.enabled ? variant : 'outline'}
        className="w-full"
        disabled={!state.enabled}
        aria-label={accessibleName}
        // The reason is announced with the button, not only shown in grey
        // beneath it: a disabled control with no explanation reads as broken.
        aria-describedby={state.reason ? reasonId : undefined}
        onClick={onClick}
      >
        {icon} {label}
      </Button>
      {state.reason && (
        // mono-600/400 rather than 500: the reason is what makes a disabled
        // button make sense, and mono-500 on the dark page is about 4.2:1,
        // under the 4.5:1 small text needs.
        <p id={reasonId} className="text-center text-xs text-mono-600 dark:text-mono-400">
          {state.reason}
        </p>
      )}
    </div>
  )
}
