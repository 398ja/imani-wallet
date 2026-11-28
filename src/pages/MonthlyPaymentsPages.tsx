import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'

import { Alert, BackLink, Button, Centered, ListSection, PageHeader, Screen, buttonClasses } from '../components/ui'
import { useBranding } from '../hooks/useBranding'
import { invalidateInstalmentPlans, useInstalmentPlans } from '../hooks/useInstalmentPlans'
import {
  formatMoney,
  paymentsNoun,
  paymentsTitle,
  perPeriod,
  progressLabel,
  readInstalmentPlan,
  statusWords,
  stopInstalmentPlan,
  type InstalmentPlan,
  type InstalmentPlanDetail,
  type StatusWords,
} from '../lib/instalments'

/**
 * Settings → Monthly payments (monthly payments spec, "Customer: managing").
 *
 * One row per plan, newest first: the stall, "£40 a month" (or "£10 a week"), "3 of 6 paid", and
 * a status chip that always carries words, never colour alone. Titled "Monthly payments" while
 * every plan is monthly, as it always was; "Regular payments" once any is not.
 */
export function MonthlyPaymentsPage({ buyerPubkey }: { buyerPubkey: string }) {
  const { plans } = useInstalmentPlans(buyerPubkey)
  if (plans === null) return <Centered>Loading…</Centered>
  const title = paymentsTitle(plans.map((p) => p.interval))
  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title={title} />
      {plans.length === 0 ? (
        <p className="text-[15px] text-mono-500">You don't pay any stall monthly.</p>
      ) : (
        <ListSection title={`Your ${title.toLowerCase()}`}>
          {plans.map((plan) => (
            <PlanRow key={plan.planId} plan={plan} />
          ))}
        </ListSection>
      )}
    </Screen>
  )
}

function PlanRow({ plan }: { plan: InstalmentPlan }) {
  const { branding } = useBranding(plan.stallPubkey)
  const words = statusWords(plan)
  return (
    <Link to={`/settings/monthly-payments/${encodeURIComponent(plan.planId)}`} className="flex items-center gap-3 p-4 press-row">
      <StallAvatar src={branding?.logoUrl} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-mono-900 dark:text-mono-50">{branding?.organizationName ?? 'A stall'}</p>
        <p className="text-sm text-mono-500">
          {formatMoney(plan.amountMinor, plan.currency)} {perPeriod(plan.interval)} · {progressLabel(plan)}
        </p>
      </div>
      <StatusChip words={words} />
      <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" aria-hidden />
    </Link>
  )
}

function StallAvatar({ src }: { src?: string }) {
  return src ? (
    <img src={src} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
  ) : (
    <div aria-hidden className="h-9 w-9 shrink-0 rounded-full bg-mono-200 dark:bg-mono-800" />
  )
}

const TONES: Record<StatusWords['tone'], string> = {
  ok: 'bg-green-50 text-green-800 dark:bg-green-950/50 dark:text-green-300',
  warn: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  danger: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  neutral: 'bg-mono-100 text-mono-700 dark:bg-mono-900 dark:text-mono-300',
}

export function StatusChip({ words }: { words: StatusWords }) {
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${TONES[words.tone]}`}>{words.chip}</span>
}

/** One plan: what it is, the vouchers it issued, and Stop. */
export function MonthlyPaymentDetailPage({ buyerPubkey }: { buyerPubkey?: string } = {}) {
  const { planId = '' } = useParams()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<InstalmentPlanDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const stopButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    readInstalmentPlan(planId).then((r) => {
      if (!live) return
      if (r.kind === 'ok') setDetail(r.value)
      else setError(r.reason)
    })
    return () => {
      live = false
    }
  }, [planId])

  const { branding } = useBranding(detail?.plan.stallPubkey)
  const name = branding?.organizationName ?? 'this stall'
  // The buyer's plans, shared with the list (one read), only to name the Back link as the list is titled.
  const { plans } = useInstalmentPlans(buyerPubkey)

  if (detail === null) {
    return error ? (
      <Screen>
        <BackLink to="/settings/monthly-payments" label="Monthly payments" />
        <Alert>{error}</Alert>
      </Screen>
    ) : (
      <Centered>Loading…</Centered>
    )
  }

  const { plan, voucherIds } = detail
  const words = statusWords(plan)
  // This plan's own words: "monthly payments" for a monthly one, "regular payments" otherwise.
  const noun = paymentsNoun([plan.interval])
  const listTitle = paymentsTitle(plans?.map((p) => p.interval) ?? [plan.interval])
  const stoppable =
    !plan.cancelRequested && (plan.status === 'ACTIVE' || plan.status === 'PAST_DUE' || plan.status === 'ATTENTION')

  const stop = async () => {
    setBusy(true)
    setError(null)
    const r = await stopInstalmentPlan(plan.planId)
    setBusy(false)
    setConfirming(false)
    if (r.kind === 'ok') {
      invalidateInstalmentPlans()
      setDetail({ plan: r.value, voucherIds })
    } else {
      setError(r.reason)
      stopButton.current?.focus()
    }
  }

  return (
    <Screen>
      {/* Back to the list, named as the list is titled for this buyer's plans. */}
      <BackLink to="/settings/monthly-payments" label={listTitle} />
      <PageHeader title={branding?.organizationName ?? paymentsTitle([plan.interval])} />

      <div className="mb-6 rounded-2xl border border-mono-200 p-4 dark:border-mono-800">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[17px] font-semibold tracking-[-0.01em]">
            {formatMoney(plan.amountMinor, plan.currency)} {perPeriod(plan.interval)}
          </p>
          <StatusChip words={words} />
        </div>
        <p className="mt-1 text-[15px] text-mono-500">{progressLabel(plan)}</p>
        <p className="mt-2 text-[15px] leading-relaxed">{words.meaning}</p>
      </div>

      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {voucherIds.length > 0 && (
        <div className="mb-6">
          <ListSection title={`Vouchers from these ${noun}`}>
            {voucherIds.map((id, i) => (
              <Link key={id} to={`/coupon/${encodeURIComponent(id)}`} className="flex items-center gap-3 p-4 press-row">
                <span className="flex-1 text-mono-900 dark:text-mono-50">Payment {i + 1}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" aria-hidden />
              </Link>
            ))}
          </ListSection>
        </div>
      )}

      {plan.status === 'PENDING' && (
        <Link to={`/buy/${plan.stallPubkey}`} className={`${buttonClasses('primary', 'lg')} w-full`}>
          Try again
        </Link>
      )}

      {stoppable && (
        <Button ref={stopButton} size="lg" variant="outline" className="w-full" disabled={busy} onClick={() => setConfirming(true)}>
          Stop {noun}
        </Button>
      )}

      <button
        type="button"
        className="pressable mt-3 inline-block py-3 text-sm text-mono-500 underline"
        onClick={() => navigate(`/merchants/${plan.stallPubkey}`)}
      >
        Go to the stall
      </button>

      {confirming && (
        <StopDialog
          stallName={name}
          noun={noun}
          busy={busy}
          onKeep={() => {
            setConfirming(false)
            stopButton.current?.focus()
          }}
          onStop={stop}
        />
      )}
    </Screen>
  )
}

/**
 * "Stop monthly payments to Green Acres?" Keeping comes first and is the plain button, as in
 * every destructive confirm here. Focus moves into the dialog, is kept there by Tab, and
 * returns to Stop when it closes (spec, Accessibility).
 */
export function StopDialog({
  stallName,
  noun = 'monthly payments',
  busy,
  onKeep,
  onStop,
}: {
  stallName: string
  /** "monthly payments", or "regular payments" for a weekly or yearly plan. */
  noun?: string
  busy: boolean
  onKeep: () => void
  onStop: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const keep = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    keep.current?.focus()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onKeep()
      return
    }
    if (e.key !== 'Tab' || !box.current) return
    const focusable = Array.from(box.current.querySelectorAll<HTMLElement>('button:not([disabled])'))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="stop-plan-title"
      aria-describedby="stop-plan-body"
      className="fixed inset-0 z-[110] flex items-center justify-center p-5"
      onKeyDown={onKeyDown}
    >
      <div aria-hidden="true" className="modal-scrim absolute inset-0 bg-mono-950/40 backdrop-blur-md dark:bg-mono-950/60" />
      <div
        ref={box}
        className="modal-surface material relative w-full max-w-sm rounded-3xl border border-mono-900/5 p-6 shadow-2xl shadow-mono-950/25 dark:border-mono-50/10 dark:shadow-black/50"
      >
        <h2 id="stop-plan-title" className="text-[17px] font-semibold leading-snug tracking-[-0.01em] text-mono-900 dark:text-mono-50">
          Stop {noun} to {stallName}?
        </h2>
        <p id="stop-plan-body" className="mt-2 text-[13px] leading-snug text-mono-600 dark:text-mono-300">
          No more payments will be taken. Vouchers you've already received are yours to keep. For a refund of a
          payment you've made, ask the stall.
        </p>
        <div className="mt-5 space-y-2">
          <Button ref={keep} size="lg" className="w-full" disabled={busy} onClick={onKeep}>
            Keep paying
          </Button>
          <Button size="lg" variant="outline" className="w-full" disabled={busy} onClick={onStop}>
            {busy ? 'Stopping…' : 'Stop'}
          </Button>
        </div>
      </div>
    </div>
  )
}
