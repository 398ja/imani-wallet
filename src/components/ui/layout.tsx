import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

/**
 * The visual vocabulary every screen is built from.
 *
 * These were file-local components copied between pages — the back button
 * existed four times byte-for-byte, the red alert pill twice, and MerchantPage's
 * `Line` and PayPage's `Row` differed only in padding. Extracting them is what
 * lets four new screens be written without a fifth copy of each.
 */

/** Page frame. Every screen is a single centred column. */
export function Screen({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-md p-5">{children}</div>
}

/**
 * Back navigation.
 *
 * Always an explicit destination, never `navigate(-1)`, so a screen reached by
 * deep link still goes somewhere sensible. The label names the parent — the
 * convention `/merchants/:pubkey` already set with its "Merchants" back link.
 */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="pressable -m-2 mb-2 inline-flex items-center gap-1 p-2 text-sm text-mono-500"
    >
      <ArrowLeft className="h-4 w-4" /> {label}
    </Link>
  )
}

/**
 * `handle` sits BETWEEN the title and the subtitle, and unlike the subtitle it
 * is in the primary ink rather than mono-500. It is not a caption on the name —
 * it is the other half of the same answer to "who is this", and the one half a
 * customer can actually type into Pay.
 */
export function PageHeader({
  title,
  handle,
  subtitle,
}: {
  title: string
  handle?: string
  subtitle?: string
}) {
  return (
    <header className="mb-6">
      <h1 className="text-xl font-semibold text-mono-900 dark:text-mono-50">{title}</h1>
      {handle ? <p className="text-sm text-mono-900 dark:text-mono-50">{handle}</p> : null}
      {subtitle ? <p className="text-sm text-mono-500">{subtitle}</p> : null}
    </header>
  )
}

/** Bordered container. The app's one surface treatment. */
export function Panel({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`rounded-2xl border border-mono-200 dark:border-mono-800 ${className}`}>
      {children}
    </div>
  )
}

/**
 * A titled group of rows, with an optional action in the header — which is where
 * "See all" lives on the capped lists.
 *
 * `adornment` is the other kind of header control, and it sits BESIDE the title
 * rather than opposite it. Proximity implies relationship: an explainer for the
 * section belongs against the words it explains, while "See all" is a
 * destination and reads correctly at the far edge. Pushing an (i) to the right
 * margin makes the reader work out what it refers to.
 */
export function ListSection({
  title,
  action,
  adornment,
  children,
}: {
  title: string
  action?: React.ReactNode
  adornment?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="flex items-center gap-1">
          <h2 className="text-sm font-medium text-mono-500">{title}</h2>
          {adornment}
        </div>
        {action}
      </div>
      <div className="divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800">
        {children}
      </div>
    </section>
  )
}

/** "See all (12)" — the link out of a capped list. */
export function SeeAll({ to, count }: { to: string; count: number }) {
  return (
    <Link
      to={to}
      className="pressable text-sm text-mono-500 hover:text-mono-900 dark:hover:text-mono-50"
    >
      See all ({count})
    </Link>
  )
}

/** Label left, value right. */
export function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    // Same split as RawDetails: a string is a field and gets the field
    // treatment, anything else renders itself — which is how a person appears
    // as a person rather than as the name of one.
    <div
      className={`flex justify-between gap-4 p-4 ${
        typeof value === 'string' ? 'items-baseline' : 'items-center'
      }`}
    >
      <span className="shrink-0 text-sm text-mono-500">{label}</span>
      {typeof value === 'string' ? (
        <span className="min-w-0 break-all text-right text-mono-900 dark:text-mono-50">{value}</span>
      ) : (
        value
      )}
    </div>
  )
}

/** Inline problem message. */
export function Alert({ children }: { children: React.ReactNode }) {
  return (
    // `role="alert"` because these appear in RESPONSE to something the user
    // did — a refused enrolment, a rejected form. Without it the message is
    // painted silently, and a screen-reader user gets no feedback at all from
    // an action that visibly failed for everyone else. The role also makes it
    // an assertive live region, which is right here: the user is waiting on
    // the outcome of the thing they just pressed.
    <p
      role="alert"
      className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
    >
      {children}
    </p>
  )
}

export function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="p-4 text-sm text-mono-500">{children}</p>
}

/**
 * The technical record, collapsed by default.
 *
 * Entries with no value are dropped by the caller rather than shown as an
 * em-dash: on this stack a DM-received coupon has no expiry and no memo, so a
 * fixed field list would be mostly blanks.
 */
export function RawDetails({ entries }: { entries: Array<[string, React.ReactNode]> }) {
  if (entries.length === 0) return null

  return (
    <details className="mb-6">
      <summary className="pressable inline-block cursor-pointer py-1 text-sm text-mono-500">Details</summary>
      <div className="mt-2 divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800">
        {entries.map(([label, value]) => (
          // Strings are record fields — ids, hashes — and keep the monospace
          // treatment. Anything else renders itself: a person is shown as a
          // person, not as the hex key that identifies them in the record.
          <div
            key={label}
            className={`flex justify-between gap-4 p-4 ${
              typeof value === 'string' ? 'items-baseline' : 'items-center'
            }`}
          >
            <span className="shrink-0 text-sm text-mono-500">{label}</span>
            {typeof value === 'string' ? (
              <span className="min-w-0 break-all text-right font-mono text-xs text-mono-400">
                {value}
              </span>
            ) : (
              value
            )}
          </div>
        ))}
      </div>
    </details>
  )
}

/** Full-screen centred message. Loading and "nothing here" states. */
export function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6 text-mono-500">
      {children}
    </div>
  )
}

export function Fatal({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-lg font-semibold text-red-600 dark:text-red-400">{title}</h1>
      <p className="max-w-sm text-sm text-mono-500">{detail}</p>
    </div>
  )
}
