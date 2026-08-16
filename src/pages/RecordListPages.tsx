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
import { couponsFor, findFarmer, findFarmerWithHistory } from '../lib/farmers'
import type { WalletTransaction } from '../lib/transactions'

/**
 * The full lists behind "See all" on the farmer screen.
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
      <BackLink to={`/farmer/${pubkey}`} label="Farmer" />
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
  const [name, setName] = useState('')

  useEffect(() => {
    const load = async () => {
      const rows = await listVouchers()
      setCoupons(couponsFor(rows, pubkey))
      setName(findFarmer(rows, pubkey)?.name ?? '')
    }
    load()
    return onWalletChanged(load)
  }, [pubkey])

  return (
    <ListFrame
      pubkey={pubkey}
      title="Coupons"
      subtitle={`${coupons.length} from ${name || 'this farmer'}`}
    >
      {coupons.length === 0 ? (
        <EmptyRow>No coupons.</EmptyRow>
      ) : (
        coupons.map((row) => <CouponListItem key={row.token_id} row={row} />)
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
      // Through the history as well: on this page especially, a farmer you hold
      // no coupons from is the normal case, and `findFarmer` alone leaves the
      // subtitle reading "3 with this farmer".
      setName(findFarmerWithHistory(rows, history, pubkey)?.name ?? '')
    }
    load()
    return onWalletChanged(load)
  }, [pubkey])

  return (
    <ListFrame
      pubkey={pubkey}
      title="Transactions"
      subtitle={`${transactions.length} with ${name || 'this farmer'}`}
    >
      {transactions.length === 0 ? (
        <EmptyRow>Nothing yet.</EmptyRow>
      ) : (
        transactions.map((tx) => <TransactionListItem key={tx.id} tx={tx} />)
      )}
    </ListFrame>
  )
}
