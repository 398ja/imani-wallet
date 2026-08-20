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
import { findMerchantWithHistory, couponsFor, type Merchant } from '../lib/merchants'
import { toMerchantPass, EMPTY_BRANDING, type MerchantBranding } from '../lib/pass'
import { merchantBranding } from '../lib/branding'
import type { WalletTransaction } from '../lib/transactions'

/** How many transactions the summary list shows before deferring to a full page. */
const PREVIEW = 3

/**
 * One merchant: their pass, and the history with them.
 *
 * The pass carries the total and IS the way into the coupon list — which is why
 * there is no separate balance panel and no inline coupon list here. Two totals
 * on one screen is worse than one, and the coupon list now lives one level
 * deeper at `/merchants/:pubkey/coupons`.
 */
export function MerchantPage() {
  const { pubkey = '' } = useParams()
  const [merchant, setMerchant] = useState<Merchant | null | undefined>(undefined)
  const [couponCount, setCouponCount] = useState(0)
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [branding, setBranding] = useState<MerchantBranding>(EMPTY_BRANDING)

  useEffect(() => {
    const load = async () => {
      const [rows, history] = await Promise.all([listVouchers(), transactionsWith(pubkey)])
      // Through the history too, or a merchant whose coupons are all spent bounces
      // off the `merchant === null` branch below with "No coupons from this
      // merchant." — over a screen whose whole other half is the history with them.
      setMerchant(findMerchantWithHistory(rows, history, pubkey) ?? null)
      // Rows, not merchant.groups[].vouchers — only the row carries token_id, and
      // that is what addresses a coupon's detail screen.
      setCouponCount(couponsFor(rows, pubkey).length)
      setTransactions(history)
    }
    load()
    return onWalletChanged(load)
  }, [pubkey])

  useEffect(() => {
    // Never rejects — an unbranded merchant falls back to the pass defaults.
    merchantBranding(pubkey).then(setBranding)
  }, [pubkey])

  if (merchant === undefined) return <Centered>Loading…</Centered>
  if (merchant === null) return <Centered>No vouchers from this merchant.</Centered>

  return (
    <Screen>
      <BackLink to="/" label="Merchants" />

      <div className="mb-6">
        <Pass pass={toMerchantPass(merchant, branding)} to={`/merchants/${pubkey}/coupons`} />
        <p className="mt-2 text-center text-sm text-mono-500">
          {couponCount === 1 ? '1 voucher' : `${couponCount} vouchers`} · tap to see them
        </p>
      </div>

      <ListSection
        title="Transactions"
        action={
          transactions.length > PREVIEW ? (
            <SeeAll to={`/merchants/${pubkey}/transactions`} count={transactions.length} />
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
