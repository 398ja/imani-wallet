import { Fragment, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ChevronDown } from 'lucide-react'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  Screen,
  BackLink,
  PageHeader,
  EmptyRow,
  CouponListItem,
  HistoryListItem,
  IdentityInline,
  Pagination,
  usePagination,
} from '../components/ui'
import { listVouchers, transactionsWith, onWalletChanged } from '../lib/wallet'
import { couponsFor, fullyRedeemedRows, issuerKey, redeemedFor } from '../lib/merchants'
import { asOneVoucher, groupByVoucher } from '../lib/voucherCount'
import { vouchers as voucherNoun } from '../lib/bundleWording'
import {
  expiredFor,
  reminderCandidates,
  sortCoupons,
  type CouponSort,
  type ReminderCandidate,
} from '../lib/couponExpiry'
import { couponReference, fullyRedeemedMessage } from '../lib/fullyRedeemed'
import { getSigner } from '../lib/nap'
import { SwapBackOffer } from '../components/SwapBackOffer'
import { useExpiryClock } from '../hooks/useExpiryReminders'
import type { WalletTransaction } from '../lib/transactions'
import { entryKey, groupHistory } from '../lib/historyGroups'

/** Whose wallet this is: the swap back's intent record is scoped by it. */
function holderPubkey(): string {
  try {
    return getSigner().pubkey
  } catch {
    return ''
  }
}

/**
 * The full lists behind "See all" on the merchant screen.
 *
 * Both are the same shape — a header, a bordered list, one row component — so
 * they share a file and a frame. The rows themselves are the same components the
 * capped lists use, which is the point: a coupon looks identical in both places.
 */

function ListFrame({
  pubkey,
  title,
  subtitle,
  children,
  footer,
  toolbar,
}: {
  pubkey: string
  title: string
  subtitle: string
  children: React.ReactNode
  /** Controls above the bordered list, such as the sort. */
  toolbar?: React.ReactNode
  /** The pagination strip, outside the bordered list it controls. */
  footer?: React.ReactNode
}) {
  return (
    <Screen>
      <BackLink to={`/merchants/${pubkey}`} label="Merchant" />
      <PageHeader title={title} subtitle={subtitle} />
      {/* Whose list this is, as a person. The subtitle used to say it in words
          — from `Merchant.name`, which is `merchantName || merchantId`, so a
          merchant who has published no kind-0 named the page with 64 hex
          characters. IdentityInline never renders a full key. */}
      <div className="mb-4">
        <IdentityInline pubkey={pubkey} size="md" />
      </div>
      {toolbar}
      <div className="divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800">
        {children}
      </div>
      {footer}
    </Screen>
  )
}

/** The list's order, remembered per device: a preference, not a fact about any coupon. */
const SORT_KEY = 'imani-wallet:coupon-sort'
function loadSort(): CouponSort {
  try {
    return localStorage.getItem(SORT_KEY) === 'newest' ? 'newest' : 'expiry'
  } catch {
    return 'expiry'
  }
}

const SORT_OPTIONS: Array<{ value: CouponSort; label: string }> = [
  { value: 'expiry', label: 'Expiring first' },
  { value: 'newest', label: 'Newest' },
]

export function CouponsPage() {
  const { pubkey = '' } = useParams()
  const [rows, setRows] = useState<VoucherRow[]>([])
  const [redeemed, setRedeemed] = useState<VoucherRow[]>([])
  // cashu-mint#540: this merchant's coupons the mint refused as redeemed in full. Still held, so
  // each offers "Swap back to sats".
  const [refused, setRefused] = useState<VoucherRow[]>([])
  /*
    #265: soonest expiry first by DEFAULT. It is the order the wallet spends in (#157), so the
    list reads in the order money will leave, and the coupon that needs using first is the one at
    the top. "Newest" keeps the received-date order this list always had, for someone looking for
    the coupon that just arrived.
  */
  const [sort, setSort] = useState<CouponSort>(loadSort)
  const [expired, setExpired] = useState<VoucherRow[]>([])
  // Live versus expired, and every badge, are functions of the clock (#265): re-read hourly and
  // whenever the app comes back into view.
  const clock = useExpiryClock()

  useEffect(() => {
    const load = async () => {
      const all = await listVouchers()
      setRows(couponsFor(all, pubkey))
      setRedeemed(redeemedFor(all, pubkey))
      setExpired(expiredFor(all, pubkey))
      setRefused(fullyRedeemedRows(all).filter((row) => issuerKey(row.issuer_id) === issuerKey(pubkey)))
    }
    load()
    return onWalletChanged(load)
  }, [pubkey, clock])

  const coupons = useMemo(() => sortCoupons(rows, sort), [rows, sort])
  // One item per VOUCHER (voucherCount.ts): a voucher filed as several rows is one voucher to
  // its holder, listed once at its whole value, in the position of its first row in this order.
  const held = useMemo(() => groupByVoucher(coupons), [coupons])
  const heldRedeemed = useMemo(() => groupByVoucher(redeemed), [redeemed])
  const chooseSort = (next: CouponSort) => {
    setSort(next)
    try {
      localStorage.setItem(SORT_KEY, next)
    } catch {
      // A refused write only forgets the choice next time.
    }
  }

  /**
   * Live coupons and spent ones are paged as ONE sequence, not two.
   *
   * They render as two groups under a heading, but a page is a page: paging
   * them separately would put two sets of controls on one screen, and a reader
   * on "page 2" would have to ask which list moved. Concatenating means the
   * redeemed heading appears on whichever page the boundary falls in, exactly
   * as it does when the whole list fits on one.
   */
  const { visible, page, pageCount, setPage } = usePagination([
    ...held.map((voucher) => ({ voucher, redeemed: false })),
    ...heldRedeemed.map((voucher) => ({ voucher, redeemed: true })),
  ])

  // Where the spent ones start ON THIS PAGE, so the heading is drawn once and
  // only when this page actually contains the first of them.
  const firstRedeemed = visible.findIndex((item) => item.redeemed)

  return (
    <ListFrame
      pubkey={pubkey}
      title="Vouchers"
      // The count is the LIVE count, matching the merchant card. Redeemed ones
      // sit below under their own heading rather than swelling this number: they
      // are receipts for value already burnt, not vouchers this wallet holds.
      subtitle={voucherNoun(held.length)}
      toolbar={
        held.length > 1 ? (
          <div className="mb-3 flex gap-2" role="group" aria-label="Sort vouchers">
            {SORT_OPTIONS.map((option) => {
              const active = sort === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => chooseSort(option.value)}
                  className={`pressable rounded-full border px-3 py-1 text-sm font-medium ${
                    active
                      ? 'border-mono-900 bg-mono-900 text-mono-50 dark:border-mono-50 dark:bg-mono-50 dark:text-mono-900'
                      : 'border-mono-200 text-mono-600 hover:bg-mono-100 dark:border-mono-800 dark:text-mono-300 dark:hover:bg-mono-900'
                  }`}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        ) : undefined
      }
      footer={
        <>
          <Pagination page={page} pageCount={pageCount} onPage={setPage} />
          <ExpiredGroup rows={expired} />
        </>
      }
    >
      {refused.map((row) => (
        <div key={row.token_id} className="border-b border-mono-100 px-4 py-3 dark:border-mono-800">
          <p className="text-sm font-medium">Redeemed in full (reference {couponReference(row.voucher_id)})</p>
          <p className="mt-1 text-sm text-mono-500">{fullyRedeemedMessage(row.voucher_id)}</p>
          <SwapBackOffer tokenId={row.token_id} pubkey={holderPubkey()} />
        </div>
      ))}
      {visible.length === 0 ? (
        <EmptyRow>{expired.length > 0 ? 'No vouchers you can still use.' : 'No vouchers.'}</EmptyRow>
      ) : (
        visible.map((item, index) => (
          <Fragment key={item.voucher.key}>
            {index === firstRedeemed && (
              <p className="bg-mono-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-mono-500 dark:bg-mono-900">
                Redeemed
              </p>
            )}
            <CouponListItem row={asOneVoucher(item.voucher)} />
          </Fragment>
        ))
      )}
    </ListFrame>
  )
}

/**
 * Coupons past their expiry, under the live list (#265).
 *
 * They used to vanish: the list said "No vouchers." and the balance dropped, with nothing to say
 * why. They are still not money (the stall will refuse them, and no balance counts them), so they
 * sit in their own group, collapsed with a count, where someone wondering "where did my voucher
 * go?" can find the answer. A plain `<details>`, as the history rows use: keyboard-operable and
 * stateless.
 */
function ExpiredGroup({ rows }: { rows: VoucherRow[] }) {
  const vouchers = groupByVoucher(rows)
  if (vouchers.length === 0) return null
  return (
    <details className="group mt-4 overflow-hidden rounded-2xl border border-mono-200 dark:border-mono-800">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-mono-600 outline-none ring-inset ring-mono-400 press-row focus-visible:ring-2 dark:text-mono-300 [&::-webkit-details-marker]:hidden">
        <span className="flex-1">Expired ({vouchers.length})</span>
        <ChevronDown
          aria-hidden
          className="h-4 w-4 shrink-0 text-mono-400 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <p className="border-t border-mono-200 px-4 py-2 text-xs text-mono-500 dark:border-mono-800">
        These ran out before they were used. They can no longer be spent and are not in your balance.
      </p>
      <div className="divide-y divide-mono-200 border-t border-mono-200 dark:divide-mono-800 dark:border-mono-800">
        {vouchers.map((voucher) => (
          <CouponListItem key={voucher.key} row={asOneVoucher(voucher)} />
        ))}
      </div>
    </details>
  )
}

/**
 * Every held coupon expiring within 7 days, across stalls, soonest first (#265): where the home
 * banner "2 vouchers expire this week" leads. Same rows as a stall's list, so a coupon looks the
 * same here; each row names its stall, since this list mixes them.
 */
export function ExpiringCouponsPage({ pubkey }: { pubkey: string }) {
  const [rows, setRows] = useState<ReminderCandidate[]>([])
  const clock = useExpiryClock()

  useEffect(() => {
    const load = async () => setRows(reminderCandidates(await listVouchers(), pubkey))
    load()
    return onWalletChanged(load)
  }, [pubkey, clock])

  return (
    <Screen>
      <BackLink to="/" label="Home" />
      <PageHeader
        title="Expiring soon"
        subtitle={rows.length === 1 ? '1 voucher expires this week' : `${rows.length} vouchers expire this week`}
      />
      <div className="divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800">
        {rows.length === 0 ? (
          <EmptyRow>Nothing expires this week.</EmptyRow>
        ) : (
          rows.map(({ row }) => (
            <div key={row.token_id}>
              {row.issuer_id ? (
                <div className="px-4 pt-3">
                  <IdentityInline pubkey={row.issuer_id} />
                </div>
              ) : null}
              <CouponListItem row={row} />
            </div>
          ))
        )}
      </div>
    </Screen>
  )
}

export function TransactionsPage() {
  const { pubkey = '' } = useParams()
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])

  useEffect(() => {
    const load = async () => {
      setTransactions(await transactionsWith(pubkey))
    }
    load()
    return onWalletChanged(load)
  }, [pubkey])

  // One line per PAYMENT: a bundle's rows fold under one entry (#106), so the
  // count and the pages are of what the reader sees, not of stored rows.
  const entries = useMemo(() => groupHistory(transactions), [transactions])
  const { visible, page, pageCount, setPage } = usePagination(entries)

  return (
    <ListFrame
      pubkey={pubkey}
      title="Transactions"
      subtitle={entries.length === 1 ? '1 entry' : `${entries.length} entries`}
      footer={<Pagination page={page} pageCount={pageCount} onPage={setPage} />}
    >
      {transactions.length === 0 ? (
        <EmptyRow>Nothing yet.</EmptyRow>
      ) : (
        visible.map((entry) => (
          <HistoryListItem key={entryKey(entry)} entry={entry} />
        ))
      )}
    </ListFrame>
  )
}
