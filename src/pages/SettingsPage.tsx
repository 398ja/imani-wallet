import { Link } from 'react-router-dom'
import { ChevronRight, User, Shield, Download, Store } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Screen, BackLink, PageHeader, ListSection } from '../components/ui'

/**
 * Settings.
 *
 * Three sections, not bottin's six: Relays, Follows and Blocks are
 * directory-social features with nothing to configure in a coupon wallet — this
 * app reads Nostr through the gateway and writes to one relay.
 *
 * A merchant gets a fourth. Deliberately NOT possa-merchant's settings page,
 * which is 975 lines across six sections — its Network/NIP-65, Stripe, LNbits
 * and Sync panels have nothing behind them on this stack, and the first two are
 * gated off by default in possa's own env defaults.
 */
export function SettingsPage({
  merchant,
}: {
  /**
   * Whether this is a merchant account: it has a stall record, open or closed.
   * False for a customer, and the Merchant section is then absent entirely.
   */
  merchant: boolean
}) {
  return (
    <Screen>
      <BackLink to="/" label="Wallet" />
      <PageHeader title="Settings" />

      <ListSection title="Account">
        <SettingRow to="/settings/profile" icon={User} label="Profile" hint="Name, photo, about" />
        <SettingRow
          to="/settings/security"
          icon={Shield}
          label="Security"
          hint="Passphrase and backup key"
        />
        <SettingRow
          to="/settings/backup"
          icon={Download}
          label="Backup"
          hint="Save a copy of your account"
        />
      </ListSection>

      {/* Merchant accounts only. A customer has no stall to configure, and
          offering them one here was offering a screen whose every field —
          issuance currency, coupon validity, categories — describes a business
          they do not have.

          Selling is chosen at registration ("I am a merchant"), which is what
          publishes the stall record; it is not something a customer switches on
          from Settings. The predicate is the record's EXISTENCE, not
          `coupon:issue`: a merchant who closes their stall loses that permission,
          and this row is the way back to reopening it. Gating on the permission
          would lock them out of their own stall. */}
      {merchant && (
        <div className="mt-6">
          <ListSection title="Merchant">
            <SettingRow
              to="/settings/merchant"
              icon={Store}
              label="Your stall"
              hint="Categories, location, coupon currency"
            />
          </ListSection>
        </div>
      )}
    </Screen>
  )
}

/**
 * A tappable settings row.
 *
 * Same shape as CouponListItem in components/ui/records.tsx — flex row, chevron,
 * hover tint — so a list of settings reads like every other list in the app.
 */
function SettingRow({
  to,
  icon: Icon,
  label,
  hint,
}: {
  to: string
  icon: LucideIcon
  label: string
  hint: string
}) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 p-4 transition-colors hover:bg-mono-100 dark:hover:bg-mono-900"
    >
      <Icon className="h-5 w-5 shrink-0 text-mono-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-mono-900 dark:text-mono-50">{label}</p>
        <p className="text-sm text-mono-500">{hint}</p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" />
    </Link>
  )
}
