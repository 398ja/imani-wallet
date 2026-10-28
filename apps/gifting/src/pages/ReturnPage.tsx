import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Centered, Notice, Screen } from '@wallet/components/ui/layout'

import { giftingApi } from '../lib/api'
import { returnLink } from '../lib/gift'
import { WALLET_ORIGIN } from '../lib/signer'
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
  // A guest's refund key R, kept in this tab since review (option D). Shown as the return link: it
  // is the buyer's own key, not the recipient's claim link (G8).
  const refundSecret = useMemo(() => findRefundSecret(draftId), [draftId])

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
      {refundSecret && WALLET_ORIGIN && draft !== 'gone' && draft.delivery.kind !== 'self' && (
        <div className="mt-6 rounded-2xl border border-mono-200 p-4 dark:border-mono-800" data-testid="return-link">
          <p className="mb-2 text-sm font-medium">Your return link</p>
          <p className="mb-2 text-sm text-mono-500">
            If it isn&apos;t claimed in time, open this link to take the gift back into a wallet. Keep it private: it is yours, not the recipient&apos;s.
          </p>
          <a className="break-all text-sm underline" href={returnLink(WALLET_ORIGIN, refundSecret)}>
            Take the gift back
          </a>
        </div>
      )}
    </Screen>
  )
}

function findRefundSecret(draftId: string): string | undefined {
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (!k?.startsWith('imani:gift:')) continue
      const kept = JSON.parse(sessionStorage.getItem(k) ?? '{}') as { draftId?: string; refundSecret?: string }
      if (kept.draftId === draftId && typeof kept.refundSecret === 'string' && /^[0-9a-f]{64}$/.test(kept.refundSecret)) return kept.refundSecret
    }
  } catch {
    // Storage blocked: the emailed return link is the copy that matters.
  }
  return undefined
}
