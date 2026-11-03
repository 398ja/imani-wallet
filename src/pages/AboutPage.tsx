import { ArrowUpRight, Cookie, FileText, LifeBuoy, Lock } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Screen, BackLink, ListSection } from '../components/ui'
import { ImaniMark } from '../components/ui/ImaniMark'
import { appVersion, buildDate, deployVersion, websitePage, PRIVACY_PATH, COOKIES_PATH, SUPPORT_EMAIL } from '../lib/about'
import { TERMS_PATH } from '../lib/terms'

/**
 * Settings → About, its own page, the same for every role (customer, stall, terminal).
 *
 * Shaped like iOS's General → About and macOS's About This Mac: the product and the version
 * first, centred, because "which version is this" is the question that brings people here;
 * then grouped rows: the release details, the legal pages, support. The wallet version is said
 * once, under the name, not repeated in a row.
 *
 * Deliberately not here: the mint. It is plumbing, not something a holder acts on here.
 *
 * The version values are ordinary selectable text (the app never sets user-select: none), so
 * they can be copied into a support message. Legal pages leave the wallet, so they open in a
 * new tab and say so with an arrow; Support is a mailto, which opens the mail app in place.
 */
export function AboutPage() {
  const built = buildDate()
  const legal: Array<{ label: string; href: string | null; icon: LucideIcon }> = [
    { label: 'Terms and Conditions', href: websitePage(TERMS_PATH), icon: FileText },
    { label: 'Privacy policy', href: websitePage(PRIVACY_PATH), icon: Lock },
    { label: 'Cookie policy', href: websitePage(COOKIES_PATH), icon: Cookie },
  ]
  const links = legal.filter((l): l is { label: string; href: string; icon: LucideIcon } => l.href !== null)

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />

      <header className="mb-8 mt-2 flex flex-col items-center text-center">
        {/* The app icon: the mark on a squircle-ish tile, inverted per theme so it reads as the
            one solid object on the page. */}
        <div className="flex h-16 w-16 items-center justify-center rounded-[1.125rem] bg-mono-900 text-mono-50 shadow-sm dark:bg-mono-50 dark:text-mono-900">
          <ImaniMark className="h-8 w-8" />
        </div>
        <h1 className="mt-4 text-2xl font-semibold leading-tight tracking-tight text-mono-900 dark:text-mono-50">
          <span className="sr-only">About </span>imani
        </h1>
        <p className="mt-1 text-sm text-mono-500 tabular-nums">
          Wallet <span data-testid="about-app-version">{appVersion()}</span>
        </p>
      </header>

      <ListSection title="Release">
        <InfoRow label="Imani release" value={releaseLabel(deployVersion())} testId="about-deploy-version" />
        {built && <InfoRow label="Built" value={built} testId="about-build-date" />}
      </ListSection>

      {links.length > 0 && (
        <ListSection title="Legal">
          {links.map((l) => (
            <LinkRow key={l.label} href={l.href} label={l.label} icon={l.icon} newTab />
          ))}
        </ListSection>
      )}

      <ListSection title="Help">
        <LinkRow href={`mailto:${SUPPORT_EMAIL}`} label="Support" hint={SUPPORT_EMAIL} icon={LifeBuoy} />
      </ListSection>
    </Screen>
  )
}

/**
 * The deploy release as shown: the tag's `imani-deploy-` prefix repeats the row's label, so it is
 * dropped (`imani-deploy-v0.3.0-671-g0f97ac0` reads `v0.3.0-671-g0f97ac0`). Anything else as is.
 */
export function releaseLabel(v: string): string {
  return v.replace(/^imani-deploy-(?=v\d)/, '')
}

/**
 * A label and a value on one line, the value trailing in the secondary ink, like iOS's About rows.
 * When both do not fit (a narrow phone, large text) the value moves under the label, still trailing,
 * as iOS does at large Dynamic Type sizes, instead of breaking mid-word beside it. Never truncated:
 * it is what gets read out or copied to Support.
 */
function InfoRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-4">
      <p className="font-medium text-mono-900 dark:text-mono-50">{label}</p>
      <p className="ml-auto min-w-0 max-w-full break-all text-right text-sm text-mono-500 tabular-nums" data-testid={testId}>
        {value}
      </p>
    </div>
  )
}

/** A tappable row, the same shape as Settings' rows (leading icon, label, hint). */
function LinkRow({
  href,
  label,
  hint,
  icon: Icon,
  newTab = false,
}: {
  href: string
  label: string
  hint?: string
  icon: LucideIcon
  newTab?: boolean
}) {
  return (
    <a
      href={href}
      {...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className="flex items-center gap-3 p-4 press-row"
    >
      <Icon className="h-5 w-5 shrink-0 text-mono-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-mono-900 dark:text-mono-50">
          {label}
          {newTab && <span className="sr-only"> (opens in a new tab)</span>}
        </p>
        {hint && <p className="truncate text-sm text-mono-500">{hint}</p>}
      </div>
      {newTab && <ArrowUpRight className="h-4 w-4 shrink-0 text-mono-400" aria-hidden />}
    </a>
  )
}
