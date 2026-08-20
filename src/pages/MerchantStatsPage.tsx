import { useEffect, useState } from 'react'

import { Screen, BackLink, PageHeader, Panel, ListSection, DetailRow } from '../components/ui'
import { listTransactions, onWalletChanged } from '../lib/wallet'
import { toTransaction } from '../lib/transactions'
import { merchantStats, type MerchantStats } from '../lib/stats'
import { currencyDecimals, formatFace } from '../lib/format'
import type { MerchantProfile } from '../lib/merchant'

/**
 * Stats — possa-merchant's dashboard, on data this wallet can actually stand
 * behind.
 *
 * Same three panels as `DashboardPage` there: the metric tiles, the status
 * snapshot, and the daily activity. The source is different and has to be: the
 * composite endpoint those read is live here and returns zeros, because it
 * cannot see coupons issued through the Sell flow. See `lib/stats.ts`.
 *
 * No chart.js. possa lazy-loads ~60KB for its activity chart; this series is a
 * handful of integers per day and CSS bars draw it with no dependency at all.
 * Swap in a charting library the day this needs axes, tooltips and zoom.
 */

const RANGES = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
] as const

const DAY_MS = 86_400_000

export function MerchantStatsPage({
  pubkey,
  merchant,
}: {
  pubkey: string
  merchant: MerchantProfile
}) {
  const [days, setDays] = useState<number>(30)
  const [stats, setStats] = useState<MerchantStats | null>(null)

  useEffect(() => {
    const load = async () => {
      const rows = (await listTransactions()).map(toTransaction)
      const now = Date.now()
      setStats(
        merchantStats(rows, {
          pubkey,
          unit: merchant.issuanceCurrency,
          decimals: currencyDecimals(merchant.issuanceCurrency),
          // days - 1: the window includes today, so "7 days" is today
          // plus the six before it, and the chart gets exactly 7 columns.
          from: now - (days - 1) * DAY_MS,
          now,
        }),
      )
    }
    load()
    return onWalletChanged(load)
  }, [pubkey, merchant.issuanceCurrency, days])

  const money = (minor: number) =>
    formatFace(minor, { unit: merchant.issuanceCurrency, decimals: currencyDecimals(merchant.issuanceCurrency) })

  return (
    <Screen>
      <BackLink to="/" label="Till" />
      <PageHeader title="Stats" subtitle={`Your own records, last ${days} days`} />

      <div className="mb-6 grid grid-cols-3 gap-2">
        {RANGES.map((range) => {
          const active = days === range.days
          return (
            <button
              key={range.days}
              type="button"
              onClick={() => setDays(range.days)}
              aria-pressed={active}
              className={`rounded-2xl border py-2 text-sm font-medium transition-colors ${
                active
                  ? 'border-mono-900 bg-mono-900 text-mono-50 dark:border-mono-50 dark:bg-mono-50 dark:text-mono-900'
                  : 'border-mono-200 text-mono-600 hover:bg-mono-100 dark:border-mono-800 dark:text-mono-300 dark:hover:bg-mono-900'
              }`}
            >
              {range.label}
            </button>
          )
        })}
      </div>

      {stats === null ? (
        <Panel className="p-5 text-center text-sm text-mono-500">Loading…</Panel>
      ) : (
        <>
          {/* The five possa shows: issued, redeemed, rate, and the two values. */}
          <div className="mb-6 grid grid-cols-2 gap-3">
            <Tile label="Vouchers issued" value={String(stats.issuedCount)} />
            <Tile label="Came back" value={String(stats.redeemedCount)} />
            <Tile label="Value issued" value={money(stats.issuedValue)} />
            <Tile label="Value taken" value={money(stats.redeemedValue)} />
            <Tile
              label="Redemption rate"
              value={`${Math.round(stats.redemptionRate * 100)}%`}
              wide
            />
          </div>

          <ListSection title="Vouchers you have issued">
            <DetailRow label="Still valid" value={String(stats.active)} />
            <DetailRow label="Expired" value={String(stats.expired)} />
            {/*
              No "redeemed" or "revoked" row, which possa's snapshot has. Neither
              is knowable here: a coupon is bearer value in the customer's wallet
              until it comes back, and there is no revoke on this stack. "Came
              back" above counts what actually returned, which is the honest
              version of the same question.
            */}
          </ListSection>

          <ListSection title="Activity">
            <div className="p-4">
              <ActivityChart activity={stats.activity} />
              <div className="mt-3 flex items-center justify-center gap-4 text-xs text-mono-500">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full bg-mono-900 dark:bg-mono-50" />
                  Issued
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full bg-green-600" />
                  Came back
                </span>
              </div>
            </div>
          </ListSection>

          {stats.otherCurrencyCount > 0 && (
            <p className="text-center text-xs text-mono-400">
              {stats.otherCurrencyCount} record
              {stats.otherCurrencyCount === 1 ? '' : 's'} in another currency
              {stats.otherCurrencyCount === 1 ? ' is' : ' are'} not counted here.
            </p>
          )}

          {/*
            Said plainly rather than left for someone to discover: these are the
            merchant's own records, not the gateway's ledger — and they follow
            the key, not the browser, now that each sale is published encrypted
            (lib/issuedRecords.ts).
          */}
          <p className="mt-2 text-center text-xs text-mono-400">
            Counted from your own sales, restored from your key.
          </p>
        </>
      )}
    </Screen>
  )
}

function Tile({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div
      className={`rounded-2xl border border-mono-200 p-4 dark:border-mono-800 ${wide ? 'col-span-2' : ''}`}
    >
      <p className="text-sm text-mono-500">{label}</p>
      <p className="mt-0.5 text-xl font-semibold text-mono-900 dark:text-mono-50">{value}</p>
    </div>
  )
}

/**
 * Daily issued and returned, as paired bars.
 *
 * Scaled to the busiest day rather than a fixed maximum, so a quiet week still
 * shows shape. A day with nothing keeps a hairline so the axis reads as a
 * timeline rather than as gaps.
 */
function ActivityChart({ activity }: { activity: MerchantStats['activity'] }) {
  const peak = Math.max(1, ...activity.map((d) => Math.max(d.issued, d.redeemed)))

  return (
    <div className="flex h-32 items-end gap-px" role="img" aria-label="Daily voucher activity">
      {activity.map((day) => (
        <div key={day.day} className="flex h-full flex-1 items-end justify-center gap-px">
          <span
            className="w-full rounded-t-sm bg-mono-900 dark:bg-mono-50"
            style={{ height: `${Math.max(1, (day.issued / peak) * 100)}%` }}
          />
          <span
            className="w-full rounded-t-sm bg-green-600"
            style={{ height: `${Math.max(1, (day.redeemed / peak) * 100)}%` }}
          />
        </div>
      ))}
    </div>
  )
}
