import { ExternalLink } from 'lucide-react'

import { ListSection } from './ui'
import { appVersion, buildDate, deployVersion, websitePage, PRIVACY_PATH, COOKIES_PATH, SUPPORT_EMAIL } from '../lib/about'
import { TERMS_PATH } from '../lib/terms'
import { trustedMintUrls } from '../lib/trustedMint'

/**
 * Settings → About, the same for every role (customer, stall, terminal).
 *
 * Release lines first, so a support conversation can start from what is running, then the
 * legal pages on the public website. Links open in a new tab: they leave the wallet.
 */
export function AboutSection() {
  const built = buildDate()
  const mint = trustedMintUrls()[0]
  const links = [
    { label: 'Terms and Conditions', href: websitePage(TERMS_PATH) },
    { label: 'Privacy policy', href: websitePage(PRIVACY_PATH) },
    { label: 'Cookie policy', href: websitePage(COOKIES_PATH) },
  ].filter((l): l is { label: string; href: string } => l.href !== null)

  return (
    <div className="mt-6">
      <ListSection title="About">
        <InfoRow label="Imani release" value={deployVersion()} testId="about-deploy-version" />
        <InfoRow label="Wallet version" value={appVersion()} testId="about-app-version" />
        {built && <InfoRow label="Built" value={built} testId="about-build-date" />}
        {mint && <InfoRow label="Mint" value={mint.replace(/^https:\/\//, '')} testId="about-mint" />}
        {links.map((l) => (
          <ExternalRow key={l.label} href={l.href} label={l.label} />
        ))}
        <ExternalRow href={`mailto:${SUPPORT_EMAIL}`} label="Contact us" hint={SUPPORT_EMAIL} newTab={false} />
      </ListSection>
    </div>
  )
}

function InfoRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-3 p-4">
      <p className="font-medium text-mono-900 dark:text-mono-50">{label}</p>
      <p className="min-w-0 truncate text-sm text-mono-500 tabular-nums" data-testid={testId}>
        {value}
      </p>
    </div>
  )
}

function ExternalRow({ href, label, hint, newTab = true }: { href: string; label: string; hint?: string; newTab?: boolean }) {
  return (
    <a
      href={href}
      {...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className="flex items-center gap-3 p-4 press-row"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-mono-900 dark:text-mono-50">{label}</p>
        {hint && <p className="text-sm text-mono-500">{hint}</p>}
      </div>
      {newTab && <ExternalLink className="h-4 w-4 shrink-0 text-mono-400" aria-hidden />}
    </a>
  )
}
