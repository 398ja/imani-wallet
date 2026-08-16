import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

import {
  Screen,
  BackLink,
  ListSection,
  SeeAll,
  EmptyRow,
  Centered,
  Pass,
  TransactionListItem,
} from '../components/ui'
import { listVouchers, transactionsWith, onWalletChanged } from '../lib/wallet'
import { findFarmerWithHistory, couponsFor, type Farmer } from '../lib/farmers'
import { toFarmerPass, EMPTY_BRANDING, type MerchantBranding } from '../lib/pass'
import { merchantBranding } from '../lib/branding'
import type { WalletTransaction } from '../lib/transactions'

/** How many transactions the summary list shows before deferring to a full page. */
const PREVIEW = 3

/**
 * One farmer: their pass, and the history with them.
 *
 * The pass carries the total and IS the way into the coupon list — which is why
 * there is no separate balance panel and no inline coupon list here. Two totals
 * on one screen is worse than one, and the coupon list now lives one level
 * deeper at `/farmer/:pubkey/coupons`.
 */
export function FarmerPage() {
  const { pubkey = '' } = useParams()
  const [farmer, setFarmer] = useState<Farmer | null | undefined>(undefined)
  const [couponCount, setCouponCount] = useState(0)
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [branding, setBranding] = useState<MerchantBranding>(EMPTY_BRANDING)

  useEffect(() => {
    const load = async () => {
      const [rows, history] = await Promise.all([listVouchers(), transactionsWith(pubkey)])
      // Through the history too, or a farmer whose coupons are all spent bounces
      // off the `farmer === null` branch below with "No coupons from this
      // farmer." — over a screen whose whole other half is the history with them.
      setFarmer(findFarmerWithHistory(rows, history, pubkey) ?? null)
      // Rows, not farmer.groups[].vouchers — only the row carries token_id, and
      // that is what addresses a coupon's detail screen.
      setCouponCount(couponsFor(rows, pubkey).length)
      setTransactions(history)
    }
    load()
    return onWalletChanged(load)
  }, [pubkey])

  useEffect(() => {
    // Never rejects — an unbranded farmer falls back to the pass defaults.
    merchantBranding(pubkey).then(setBranding)
  }, [pubkey])

  if (farmer === undefined) return <Centered>Loading…</Centered>
  if (farmer === null) return <Centered>No coupons from this farmer.</Centered>

  return (
    <Screen>
      <BackLink to="/" label="Farmers" />

      <div className="mb-6">
        <Pass pass={toFarmerPass(farmer, branding)} to={`/farmer/${pubkey}/coupons`} />
        <p className="mt-2 text-center text-sm text-mono-500">
          {couponCount === 1 ? '1 coupon' : `${couponCount} coupons`} · tap to see them
        </p>
      </div>

      <ListSection
        title="Transactions"
        action={
          transactions.length > PREVIEW ? (
            <SeeAll to={`/farmer/${pubkey}/transactions`} count={transactions.length} />
          ) : undefined
        }
      >
        {transactions.length === 0 ? (
          <EmptyRow>Nothing yet.</EmptyRow>
        ) : (
          transactions.slice(0, PREVIEW).map((tx) => <TransactionListItem key={tx.id} tx={tx} />)
        )}
      </ListSection>
    </Screen>
  )
}
