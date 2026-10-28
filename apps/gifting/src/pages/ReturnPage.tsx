import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Centered, Notice, Screen } from '@wallet/components/ui/layout'

import { giftingApi } from '../lib/api'
import type { Draft } from '../lib/draft'

const api = giftingApi()

/**
 * Where Stripe sends the buyer back (#410 §3 return/status page).
 *
 * Shows, never decides: delivery runs from Stripe's webhook whether or not this page ever loads
 * (G-R2). The URL only says which draft to describe; the recipient comes from the server's pinned
 * draft, never from query parameters, and the claim link is never shown (G8).
 */
export function ReturnPage() {
  const [params] = useSearchParams()
  const draftId = params.get('draft') ?? ''
  const cancelled = params.get('cancelled') === '1'
  const valid = /^[0-9a-f-]{8,64}$/i.test(draftId)
  const [fetched, setFetched] = useState<Draft | 'gone' | null>(null)

  useEffect(() => {
    if (!valid) return
    api.getDraft(draftId).then(setFetched, () => setFetched('gone'))
  }, [draftId, valid])
  const draft = valid ? fetched : 'gone'

  if (cancelled)
    return (
      <Screen>
        <h1 className="mb-2 mt-8 text-title font-semibold">Nothing was charged.</h1>
        <p className="text-callout text-mono-500">You can go back and pay again while your gift is still saved.</p>
        <button type="button" className="pressable mt-4 underline" onClick={() => history.back()}>
          Back to the review
        </button>
      </Screen>
    )

  if (draft === null) return <Centered>Checking your payment…</Centered>

  const where =
    draft === 'gone'
      ? 'the recipient you chose'
      : draft.delivery.kind === 'self'
        ? 'your wallet. Open the Imani wallet to see it'
        : draft.delivery.kind === 'email'
          ? `${draft.delivery.email}, with a link to claim it`
          : 'their wallet'

  return (
    <Screen>
      <h1 className="mb-4 mt-8 text-title font-semibold">Thank you</h1>
      <Notice tone="success">Your payment went through. Your voucher is on its way to {where}.</Notice>
      <p className="mt-4 text-sm text-mono-500">
        It can take a minute. If it isn&apos;t claimed in time, it comes back to you: to your wallet if you were signed in, or through the return link
        we email you.
      </p>
    </Screen>
  )
}
