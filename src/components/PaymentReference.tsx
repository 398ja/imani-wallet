import { useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, Copy, HelpCircle, RotateCcw, ShieldAlert } from 'lucide-react'

import { compactReference } from '../lib/paymentReference'
import { processorName, processorOfReference } from '../lib/cardProcessor'
import type { ReferenceVerification } from '../lib/referenceVerification'
import { useReferenceVerification } from '../lib/useReferenceVerification'

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
 * Refunded and disputed payments are reported (amber) but not acted on:
 * reversing the voucher is payment-adapter#265.
 *
 * The processor is named from the reference's shape (Stripe `pi_…`, PayPal capture id), so a
 * PayPal sale says "PayPal" everywhere this says "Stripe" (payment-adapter ADR 0002).
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
      // Vertical padding cancelled by a negative margin: the row keeps its
      // height and the tap target grows to a usable size. It was the 16px line
      // box of the monospace text alone.
      className="pressable -my-3.5 inline-flex min-w-0 items-center gap-1.5 rounded-md py-3.5 font-mono text-xs text-mono-500"
    >
      <span className="truncate">{compact ? compactReference(reference) : reference}</span>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {/* Always mounted, so the change is announced. A live region inserted
          already holding its text is not read by most screen readers. */}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  )
}

/**
 * The verdict as one mark, in ValidationBadge's vocabulary: its own glyph per
 * state so colour is never the only signal, green-600 for genuine, red-500 for
 * a server-confirmed problem, amber-600 for a genuine payment since refunded or
 * disputed (a caution, not an accusation), and muted mono-500 for checking or could-not-check
 * (the resting state, so it must not cry wolf).
 */
const REFERENCE_STYLE = {
  verified: { Icon: CheckCircle2, tone: 'text-green-600', label: (n: string) => `Genuine payment on your ${n} account` },
  refunded: { Icon: RotateCcw, tone: 'text-amber-600', label: (n: string) => `Refunded on ${n}` },
  disputed: { Icon: ShieldAlert, tone: 'text-amber-600', label: (n: string) => `Disputed on ${n}` },
  failed: { Icon: AlertTriangle, tone: 'text-red-500', label: (n: string) => `Not a matching payment on your ${n} account` },
  unknown: { Icon: HelpCircle, tone: 'text-mono-500', label: (n: string) => `Could not check this payment with ${n}` },
  checking: { Icon: HelpCircle, tone: 'text-mono-500', label: (n: string) => `Checking this payment with ${n}` },
} as const

/** Which processor issued this reference, by name. Stripe for anything else, as before PayPal. */
function nameFor(reference: string): string {
  return processorName(processorOfReference(reference) ?? 'stripe')
}

type ReferenceState = keyof typeof REFERENCE_STYLE

function referenceState(answer: ReferenceVerification | undefined): ReferenceState {
  if (answer === undefined) return 'checking'
  return answer.kind === 'reversed' ? answer.result : answer.kind
}

export function ReferenceVerificationBadge({
  verification,
  className = '',
  processor = 'Stripe',
}: {
  verification: ReferenceVerification | undefined
  className?: string
  /** The processor's name, for the label. */
  processor?: string
}) {
  const state = referenceState(verification)
  const { Icon, tone } = REFERENCE_STYLE[state]
  const label = REFERENCE_STYLE[state].label(processor)
  return (
    <Icon
      data-testid="reference-verification"
      data-state={state}
      className={`h-[1em] w-[1em] shrink-0 ${tone} ${className}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
    </Icon>
  )
}

/** The compact mark for a list row: the badge alone, asking on its own. */
export function CardReferenceMark({ reference }: { reference: string }) {
  return <ReferenceVerificationBadge verification={useReferenceVerification(reference)} processor={nameFor(reference)} />
}

/** The one-line explanation under the full reference. */
function referenceSentence(answer: ReferenceVerification | undefined, n: string): string {
  if (answer === undefined) return `Checking with ${n}…`
  if (answer.kind === 'verified') return `Genuine: a succeeded payment on your ${n} account, for this amount.`
  if (answer.kind === 'reversed') {
    const what = answer.result === 'refunded' ? `Refunded on ${n}.` : `Disputed on ${n}.`
    return `${what} The voucher was still issued. Refunds and disputes are not handled automatically, so check your ${n} dashboard.`
  }
  if (answer.kind === 'failed') {
    return answer.result === 'not_found'
      ? `Not found on your ${n} account. Check your ${n} dashboard before honouring it.`
      : `Found on your ${n} account, but it does not match this purchase. Check your ${n} dashboard.`
  }
  return `Could not check with ${n} right now.`
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
  const verification = useReferenceVerification(reference)
  const state = referenceState(verification)
  const n = nameFor(reference)
  return (
    <div data-testid="payment-reference" className="flex flex-col gap-1 p-4">
      <span className="text-sm text-mono-500">Card payment reference ({n})</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <ReferenceVerificationBadge verification={verification} className="text-sm" processor={n} />
        <CopyReferenceButton reference={reference} />
      </span>
      <span className="text-sm text-mono-500">
        {amount} · Paid {date}
      </span>
      <span
        aria-live="polite"
        className={`text-sm ${REFERENCE_STYLE[state].tone}`}
      >
        {referenceSentence(verification, n)}
      </span>
    </div>
  )
}
