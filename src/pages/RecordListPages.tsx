import { Fragment, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  Screen,
  BackLink,
  PageHeader,
  EmptyRow,
  CouponListItem,
  TransactionListItem,
  IdentityInline,
  Pagination,
  usePagination,
} from '../components/ui'
import { listVouchers, transactionsWith, onWalletChanged } from '../lib/wallet'
import { couponsFor, redeemedFor } from '../lib/merchants'
import type { WalletTransaction } from '../lib/transactions'

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
}: {
  pubkey: string
  title: string
  subtitle: string
  children: React.ReactNode
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
      <div className="divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800">
        {children}
      </div>
      {footer}
    </Screen>
  )
}

export function CouponsPage() {
  const { pubkey = '' } = useParams()
  const [coupons, setCoupons] = useState<VoucherRow[]>([])
  const [redeemed, setRedeemed] = useState<VoucherRow[]>([])

  useEffect(() => {
    const load = async () => {
      const rows = await listVouchers()
      setCoupons(couponsFor(rows, pubkey))
      setRedeemed(redeemedFor(rows, pubkey))
    }
    load()
    return onWalletChanged(load)
  }, [pubkey])

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
    ...coupons.map((row) => ({ row, redeemed: false })),
    ...redeemed.map((row) => ({ row, redeemed: true })),
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
      subtitle={coupons.length === 1 ? '1 voucher' : `${coupons.length} vouchers`}
      footer={<Pagination page={page} pageCount={pageCount} onPage={setPage} />}
    >
      {visible.length === 0 ? (
        <EmptyRow>No vouchers.</EmptyRow>
      ) : (
        visible.map((item, index) => (
          <Fragment key={item.row.token_id}>
            {index === firstRedeemed && (
              <p className="bg-mono-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-mono-500 dark:bg-mono-900">
                Redeemed
              </p>
            )}
            <CouponListItem row={item.row} />
          </Fragment>
        ))
      )}
    </ListFrame>
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

  const { visible, page, pageCount, setPage } = usePagination(transactions)

  return (
    <ListFrame
      pubkey={pubkey}
      title="Transactions"
      subtitle={transactions.length === 1 ? '1 entry' : `${transactions.length} entries`}
      footer={<Pagination page={page} pageCount={pageCount} onPage={setPage} />}
    >
      {transactions.length === 0 ? (
        <EmptyRow>Nothing yet.</EmptyRow>
      ) : (
        visible.map((tx) => <TransactionListItem key={tx.id} tx={tx} />)
      )}
    </ListFrame>
  )
}
