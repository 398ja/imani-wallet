import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { compactReference } from '../lib/paymentReference'

/**
 * The processor's reference for a card sale, made usable (imani-wallet#267 item 4).
 *
 * The `pi_…` id was only printed inside a sentence. A merchant reconciling
 * against Stripe needs to copy it, and on an Express dashboard (which is what
 * payment-adapter creates, and which has no full id search) they also need the
 * amount and the date to find the payment by eye, so the record shows all three
 * together.
 *
 * No dashboard deep link. `dashboard.stripe.com/payments/{pi}` only works for
 * the platform or a Standard account, and an Express merchant needs a login
 * link minted server-side, for which no endpoint exists yet. A link that opens
 * a login wall or "not found" is worse than none.
 *
 * "Refunded/Disputed" is out of scope until payment-adapter#265 exposes it.
 */

function useCopy(text: string) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // No clipboard (insecure context): the full ref is still on screen.
    }
  }
  return { copied, copy }
}

/** A copy control for a reference, full or compact. */
export function CopyReferenceButton({ reference, compact = false }: { reference: string; compact?: boolean }) {
  const { copied, copy } = useCopy(reference)
  const Icon = copied ? Check : Copy
  return (
    <button
      type="button"
      aria-label="Copy payment reference"
      title={reference}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void copy()
      }}
      className="pressable inline-flex min-w-0 items-center gap-1.5 rounded-md font-mono text-xs text-mono-500"
    >
      <span className="truncate">{compact ? compactReference(reference) : reference}</span>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {copied ? <span className="sr-only">Copied</span> : null}
    </button>
  )
}

/** The reconciliation block on a voucher record: reference, amount, date. */
export function PaymentReferenceBlock({
  reference,
  amount,
  date,
}: {
  reference: string
  amount: string
  date: string
}) {
  return (
    <div data-testid="payment-reference" className="flex flex-col gap-1 p-4">
      <span className="text-sm text-mono-500">Card payment reference</span>
      <CopyReferenceButton reference={reference} />
      <span className="text-sm text-mono-500">
        {amount} · Paid {date}
      </span>
    </div>
  )
}
