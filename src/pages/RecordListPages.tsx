import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  Screen,
  BackLink,
  PageHeader,
  EmptyRow,
  CouponListItem,
  TransactionListItem,
} from '../components/ui'
import { listVouchers, transactionsWith, onWalletChanged } from '../lib/wallet'
import { couponsFor, findMerchant, findMerchantWithHistory, redeemedFor } from '../lib/merchants'
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
}: {
  pubkey: string
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <Screen>
      <BackLink to={`/merchants/${pubkey}`} label="Shop" />
      <PageHeader title={title} subtitle={subtitle} />
      <div className="divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800">
        {children}
      </div>
    </Screen>
  )
}

export function CouponsPage() {
  const { pubkey = '' } = useParams()
  const [coupons, setCoupons] = useState<VoucherRow[]>([])
  const [redeemed, setRedeemed] = useState<VoucherRow[]>([])
  const [name, setName] = useState('')

  useEffect(() => {
    const load = async () => {
      const rows = await listVouchers()
      setCoupons(couponsFor(rows, pubkey))
      setRedeemed(redeemedFor(rows, pubkey))
      setName(findMerchant(rows, pubkey)?.name ?? '')
    }
    load()
    return onWalletChanged(load)
  }, [pubkey])

  return (
    <ListFrame
      pubkey={pubkey}
      title="Vouchers"
      // The count is the LIVE count, matching the shop card. Redeemed ones sit
      // below under their own heading rather than swelling this number: they are
      // receipts for value already burnt, not vouchers this wallet holds.
      subtitle={`${coupons.length} from ${name || 'this shop'}`}
    >
      {coupons.length === 0 ? (
        <EmptyRow>No vouchers.</EmptyRow>
      ) : (
        coupons.map((row) => <CouponListItem key={row.token_id} row={row} />)
      )}
      {redeemed.length > 0 && (
        <>
          <p className="bg-mono-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-mono-500 dark:bg-mono-900">
            Redeemed
          </p>
          {redeemed.map((row) => (
            <CouponListItem key={row.token_id} row={row} />
          ))}
        </>
      )}
    </ListFrame>
  )
}

export function TransactionsPage() {
  const { pubkey = '' } = useParams()
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [name, setName] = useState('')

  useEffect(() => {
    const load = async () => {
      const [rows, history] = await Promise.all([listVouchers(), transactionsWith(pubkey)])
      setTransactions(history)
      // Through the history as well: on this page especially, a merchant you hold
      // no coupons from is the normal case, and `findMerchant` alone leaves the
      // subtitle reading "3 with this merchant".
      setName(findMerchantWithHistory(rows, history, pubkey)?.name ?? '')
    }
    load()
    return onWalletChanged(load)
  }, [pubkey])

  return (
    <ListFrame
      pubkey={pubkey}
      title="Transactions"
      subtitle={`${transactions.length} with ${name || 'this shop'}`}
    >
      {transactions.length === 0 ? (
        <EmptyRow>Nothing yet.</EmptyRow>
      ) : (
        transactions.map((tx) => <TransactionListItem key={tx.id} tx={tx} />)
      )}
    </ListFrame>
  )
}
