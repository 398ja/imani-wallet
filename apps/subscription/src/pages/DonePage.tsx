import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check } from 'lucide-react'

import { buttonClasses } from '@wallet/components/ui/buttonClasses'
import { Screen } from '@wallet/components/ui/layout'

/**
 * Back from Stripe. The licence is minted on Stripe's webhook, a few seconds later. The session
 * cookie survived the trip to Stripe, so the plan is refreshed here until it shows.
 */
export function DonePage({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (tick > 5) return
    const t = setTimeout(() => {
      void onRefresh()
      setTick((n) => n + 1)
    }, 3000)
    return () => clearTimeout(t)
  }, [tick, onRefresh])

  return (
    <Screen>
      <div className="mt-10 flex flex-col items-center text-center">
        <div className="mb-4 rounded-full bg-green-600/10 p-3">
          <Check className="h-7 w-7 text-green-600" />
        </div>
        <h1 className="text-title font-semibold">Thank you, you are subscribed</h1>
        <p className="mt-2 text-callout text-mono-500">
          Your plan is on its way to your Imani wallet and turns on by itself, usually within a minute. Your receipt is in your
          email.
        </p>
        <Link to="/account" className={`${buttonClasses('primary', 'md')} mt-6`}>
          See my plan
        </Link>
      </div>
    </Screen>
  )
}
