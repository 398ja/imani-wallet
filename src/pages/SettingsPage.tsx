import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { ChevronRight, User, Shield, Download, Store, ShieldCheck, BadgeCheck, Tablet, CreditCard, Bell, Info, LifeBuoy, HeartPulse, Globe, Lock } from 'lucide-react'

import { fleetConfig, supportSnapshotConfig } from '../lib/config'
import { licenceStatus, type LicenceStatus } from '../lib/licenceStatus'
import { ONLINE_SHOP_PLAN_NAME, connectedShop, onlineShopAccess, type OnlineShopAccess } from '../lib/onlineShopAccess'
import { shopHost } from '../lib/shopEnrol'
import { allTerminals } from '../lib/terminalRoster'
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
  stallPubkey,
  status,
}: {
  /**
   * Whether this is a merchant account: it has a stall record, open or closed.
   * False for a customer, and the Merchant section is then absent entirely.
   */
  merchant: boolean
  /** The account's key, which is the stall's when `merchant`. Absent in older callers and tests. */
  stallPubkey?: string
  /** Injected by tests. The licence check otherwise. */
  status?: (pubkey: string) => Promise<LicenceStatus>
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
          hint="Change your passphrase"
        />
        <SettingRow
          to="/settings/backup"
          icon={Download}
          label="Backup"
          hint="Backup key, file and Google Drive"
        />
        {/* In Account rather than a section of its own: there is one row, and a
            heading over a single item is a heading that earns nothing. */}
        <SettingRow
          to="/settings/notifications"
          icon={Bell}
          label="Notifications"
          hint="What Imani tells you about"
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
              label="Your business"
              hint="Categories, location, voucher currency"
            />
            <SettingRow
              to="/settings/ledger"
              icon={ShieldCheck}
              label="Redemption ledger"
              hint="What you have published, your ledger ID, and gaps"
            />
            {/* Listed whether or not a stall has connected. The screen behind
                it is where a merchant learns card payments exist at all, and
                hiding it until they are connected is a chicken and egg. */}
            <SettingRow
              to="/settings/payments"
              icon={CreditCard}
              label="Card payments"
              hint="Take card payments for your vouchers"
            />
            {stallPubkey ? <OnlineShopRow stallPubkey={stallPubkey} status={status} /> : null}
            <SettingRow
              to="/settings/terminals"
              icon={Tablet}
              label="Terminals"
              hint="Devices trading for your stall, on Essentials and above"
            />
            {/* Listed rather than hidden. The screen behind it is gated by the
                real licence check and shows its own refusal, so a merchant
                without a subscription is told why — which is the answer to
                "why did my terminals stop?" and is useless if it is only
                reachable by someone who already knows the URL. */}
            <SettingRow
              to="/settings/subscription"
              icon={BadgeCheck}
              label="Subscription"
              hint="What it unlocks, until when, and why"
            />
          </ListSection>
        </div>
      )}

      {/* Every role, last: what is running, the legal pages, support. Its own page (AboutPage). */}
      <div className="mt-6">
        <ListSection title="Imani">
          <AboutRow />
          <SupportSnapshotRow />
          <FleetRow />
        </ListSection>
      </div>
    </Screen>
  )
}

/** Stable, so the row's effect runs once per stall and not on every render. */
const ownerLicenceStatus = (pubkey: string) => licenceStatus({ pubkey })

/**
 * Settings › Merchant › Online shop (#402). LISTED for every merchant, locked below the plan that
 * includes `ecommerce`: hidden, the Subscription page would be the only place a merchant learns
 * online shops exist. Shows the connected shop when there is one, whatever the plan, so a lapsed
 * merchant can still reach it to disconnect.
 *
 * The plan check is async; until it answers the row shows the neutral hint, never a lock that
 * might be wrong.
 */
function OnlineShopRow({
  stallPubkey,
  status = ownerLicenceStatus,
}: {
  stallPubkey: string
  status?: (pubkey: string) => Promise<LicenceStatus>
}) {
  const [access, setAccess] = useState<OnlineShopAccess | null>(null)
  const shop = connectedShop(allTerminals(stallPubkey))
  useEffect(() => {
    let live = true
    status(stallPubkey).then(
      (s) => live && setAccess(onlineShopAccess(s, allTerminals(stallPubkey))),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [stallPubkey, status])
  const hint = shop?.shop
    ? `Connected: ${shopHost(shop.shop.url)}`
    : access === 'locked'
      ? `Available on ${ONLINE_SHOP_PLAN_NAME}`
      : 'Let customers pay with your coupons on your website'
  return (
    <SettingRow
      to="/settings/online-shop"
      icon={Globe}
      label="Online shop"
      hint={hint}
      locked={access === 'locked' && !shop}
    />
  )
}

/**
 * Settings > Help > Share a support snapshot (#589). Shown only when the gateway names a support
 * Blossom and npub, so a deployment without the feature shows nothing (criterion 13).
 */
function SupportSnapshotRow() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    supportSnapshotConfig().then((c) => live && setOn(c !== null), () => undefined)
    return () => {
      live = false
    }
  }, [])
  if (!on) return null
  return <SettingRow to="/settings/help/snapshot" icon={LifeBuoy} label="Share a support snapshot" hint="Only when Imani support asks" />
}

/**
 * Settings > Help > Help improve Imani (#591). Shown only when the gateway serves fleet_enabled: true
 * and a support npub; otherwise nothing, and nothing is sent.
 */
function FleetRow() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    fleetConfig().then((c) => live && setOn(c.enabled), () => undefined)
    return () => {
      live = false
    }
  }, [])
  if (!on) return null
  return <SettingRow to="/settings/help/improve" icon={HeartPulse} label="Help improve Imani" hint="Share an anonymised health check now and then" />
}

/** The row into Settings → About. Shared with the terminal's Settings, so every role has the same one. */
export function AboutRow() {
  return <SettingRow to="/settings/about" icon={Info} label="About" hint="Version, legal, support" />
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
  locked = false,
}: {
  to: string
  icon: LucideIcon
  label: string
  hint: string
  /** Shows a lock: the screen behind it explains the plan that unlocks it. Still tappable. */
  locked?: boolean
}) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 p-4 press-row"
    >
      <Icon className="h-5 w-5 shrink-0 text-mono-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-mono-900 dark:text-mono-50">{label}</p>
        <p className="text-sm text-mono-500">{hint}</p>
      </div>
      {locked ? <Lock className="h-4 w-4 shrink-0 text-mono-400" aria-label="Locked" data-testid="setting-locked" /> : null}
      <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" />
    </Link>
  )
}
