import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Clock, QrCode, Send } from 'lucide-react'

import {
  Button,
  Screen,
  Panel,
  ListSection,
  EmptyRow,
  TransactionListItem,
} from '../components/ui'
import { listTransactions, listVouchers, onWalletChanged } from '../lib/wallet'
import { toMerchants, walletTotals } from '../lib/merchants'
import { toTransaction, type WalletTransaction } from '../lib/transactions'
import { expiringSoon, outstandingLiability } from '../lib/stats'
import { currencyDecimals, formatDate, formatFace } from '../lib/format'
import type { MerchantProfile } from '../lib/merchant'

/**
 * Home, for a merchant.
 *
 * Same skeleton as MerchantsPage — balance panel, then the two things you can do —
 * with Sell and Redeem where a customer has Pay and Receive. The figure differs
 * though: a customer's headline is what they hold, a merchant's is what they
 * owe. Coupons taken in still show, on the line under it, from the same
 * `walletTotals` the customer screen uses — they arrive here as ordinary
 * vouchers, so that needs no merchant-specific variant.
 *
 * Deliberately not the dashboard — that lives at /merchant/stats. This screen is
 * the till, and a till should open on the two buttons you press all day, with
 * the last few movements under them the way the shop pass shows three and a
 * "See all", plus anything about to expire while it can still be spent.
 */
export function MerchantHomePage({
  pubkey,
  merchant,
}: {
  pubkey: string
  merchant: MerchantProfile
}) {
  const navigate = useNavigate()
  const [totals, setTotals] = useState<ReturnType<typeof walletTotals> | null>(null)
  const [owed, setOwed] = useState(0)
  const [recent, setRecent] = useState<WalletTransaction[] | null>(null)
  const [expiring, setExpiring] = useState<WalletTransaction[]>([])

  useEffect(() => {
    const load = async () => {
      const [vouchers, transactions] = await Promise.all([listVouchers(), listTransactions()])
      const rows = transactions.map(toTransaction)
      setTotals(walletTotals(toMerchants(vouchers)))
      setOwed(
        outstandingLiability(rows, { pubkey, unit: merchant.issuanceCurrency, now: Date.now() }),
      )
      setRecent([...rows].sort((a, b) => b.at - a.at).slice(0, 3))
      // `Date.now()` here in the effect, not in the render body — an expiry that
      // silently flips between renders is the impurity lint catches elsewhere.
      setExpiring(expiringSoon(rows, { now: Date.now() }).slice(0, 3))
    }
    load()
    // Live for the same reason the customer home is: a redemption landing by DM
    // while this screen is open must show up without a refresh. It is also what
    // makes the Redeem screen's own fulfilment watcher trustworthy.
    return onWalletChanged(load)
  }, [pubkey, merchant.issuanceCurrency])

  const [primary, ...rest] = totals ?? []
  // The merchant's own currency stands in when there is nothing held yet:
  // `formatFace(0, undefined)` has no unit to work with and renders a bare "0".
  const issuance = {
    unit: merchant.issuanceCurrency,
    decimals: currencyDecimals(merchant.issuanceCurrency),
  }

  return (
    <Screen>
      {/*
        No name-and-handle heading: the app header carries both on every screen,
        and printing them again here was the same two lines twice.
      */}
      <Panel className="mb-6 p-5">
        <p className="text-sm text-mono-500">Outstanding vouchers</p>
        <p className="text-amount text-mono-900 dark:text-mono-50">
          {formatFace(owed, issuance)}
        </p>
        {/* What is held, under what is owed — still worth a glance, and it is
            the customer wallet's headline figure. */}
        <p className="text-sm text-mono-500">
          Taken in {formatFace(primary?.minor ?? 0, primary ?? issuance)}
          {rest.map((total) => ` + ${formatFace(total.minor, total)}`).join('')}
        </p>
      </Panel>

      <div className="mb-6 grid grid-cols-2 gap-3">
        <Button size="lg" onClick={() => navigate('/sell')}>
          <Send className="mr-2 h-5 w-5" /> Sell
        </Button>
        <Button size="lg" variant="outline" onClick={() => navigate('/redeem')}>
          <QrCode className="mr-2 h-5 w-5" /> Redeem
        </Button>
      </div>

      {/* The wallet's established pattern: a few recent rows with a See all,
          rather than a link to a list you have to open to learn anything. */}
      <ListSection title="Recent">
        {recent === null ? (
          <EmptyRow>Loading…</EmptyRow>
        ) : recent.length === 0 ? (
          <EmptyRow>
            Sell issues a voucher to a customer. Redeem takes vouchers as payment.
          </EmptyRow>
        ) : (
          recent.map((tx) => <TransactionListItem key={tx.id} tx={tx} />)
        )}
      </ListSection>

      {/*
        Transactions only. Issued coupons are reached through the movement that
        created them — a row here, then "View coupon" on its detail — so a second
        link straight to the coupon list would be a parallel route to the same
        records, and it is what makes the coupon page's back-link to the
        transaction make sense.

        `/merchant/coupons` still exists and still works; nothing links to it.
      */}
      <div className="mt-3 text-right">
        <Link
          to="/merchant/transactions"
          className="pressable text-sm text-mono-500 hover:text-mono-900 dark:hover:text-mono-50"
        >
          All transactions
        </Link>
      </div>

      {/*
        Rendered only when there is something to act on. An "Expiring soon (0)"
        box every day of the year trains a merchant to stop reading it, so the
        section is absent rather than empty — its presence IS the signal.
      */}
      {expiring.length > 0 && (
        <div className="mt-6">
          <ListSection title="Expiring soon">
            {expiring.map((tx) => (
              <Link
                key={tx.id}
                to={`/merchant/coupon/${encodeURIComponent(tx.voucherId ?? '')}`}
                className="flex items-center gap-3 p-4 press-row"
              >
                <Clock className="h-4 w-4 shrink-0 text-red-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-mono-900 dark:text-mono-50">
                    {tx.memo || 'Voucher issued'}
                  </p>
                  <p className="truncate text-sm text-mono-500">
                    Expires {formatDate(tx.expiresAt)}
                  </p>
                </div>
                <p className="shrink-0 text-right text-mono-900 dark:text-mono-50">
                  {formatFace(tx.amount, { unit: tx.unit, decimals: tx.decimals })}
                </p>
              </Link>
            ))}
          </ListSection>
        </div>
      )}
    </Screen>
  )
}
