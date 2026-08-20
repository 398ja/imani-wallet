import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronRight, Clock } from 'lucide-react'

import {
  Screen,
  BackLink,
  PageHeader,
  EmptyRow,
  TransactionListItem,
  Panel,
  ListSection,
  DetailRow,
  RawDetails,
  Centered,
  IdentityInline,
} from '../components/ui'
import { getTransactionRow, listTransactions, onWalletChanged } from '../lib/wallet'
import { toTransaction, type WalletTransaction } from '../lib/transactions'
import { formatDate, formatFace } from '../lib/format'
import { identityLabel, useIdentity } from '../lib/identity'

/**
 * The merchant's two history screens.
 *
 * Both read the SAME store — this wallet's own transaction rows — and differ
 * only in the filter, which is why they share a file:
 *
 * - **Transactions** is everything: coupons issued out (written by
 *   `issueAndDeliver`) and coupons taken in as payment (written by the receive
 *   pipeline when a customer pays a Redeem request).
 * - **Issued coupons** is the outgoing half, shown per coupon rather than per
 *   movement, with the expiry the customer will see.
 *
 * Not backed by `GET /api/v1/portal/vouchers`, which looks like the obvious
 * source for the second one and is not — see `buildIssueTransaction` in
 * lib/transactions.ts for what that endpoint actually lists and why coupons from
 * the Sell flow are absent from it.
 */

/**
 * Newest first, and only what this wallet wrote.
 *
 * `loadedAt` comes back with the rows rather than being read at render time.
 * `Date.now()` in a render body is impure — React may re-render at any moment,
 * and a row could silently flip to "expired" mid-interaction with nothing having
 * changed. Captured once per load, it moves only when the data does.
 */
function useMerchantTransactions() {
  const [state, setState] = useState<{
    transactions: WalletTransaction[]
    loadedAt: number
  } | null>(null)

  useEffect(() => {
    const load = async () => {
      const rows = (await listTransactions()).map(toTransaction)
      setState({ transactions: rows.sort((a, b) => b.at - a.at), loadedAt: Date.now() })
    }
    load()
    // Live for the same reason every other list here is: a redemption landing by
    // DM while the screen is open must appear without a refresh.
    return onWalletChanged(load)
  }, [])

  return state
}

function ListFrame({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <Screen>
      <BackLink to="/" label="Till" />
      <PageHeader title={title} subtitle={subtitle} />
      <div className="divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800">
        {children}
      </div>
    </Screen>
  )
}

/** Everything that moved, both directions. */
export function MerchantTransactionsPage() {
  const transactions = useMerchantTransactions()?.transactions ?? null

  return (
    <ListFrame
      title="Transactions"
      subtitle={
        transactions === null
          ? 'Loading…'
          : `${transactions.length} ${transactions.length === 1 ? 'entry' : 'entries'}`
      }
    >
      {transactions === null ? (
        <EmptyRow>Loading…</EmptyRow>
      ) : transactions.length === 0 ? (
        <EmptyRow>Nothing yet. Sales and redemptions show up here.</EmptyRow>
      ) : (
        // The same row component the customer screens use, so a movement looks
        // identical wherever it is listed.
        transactions.map((tx) => <TransactionListItem key={tx.id} tx={tx} />)
      )}
    </ListFrame>
  )
}

/** Just the coupons this merchant put into circulation. */
export function IssuedCouponsPage() {
  const state = useMerchantTransactions()
  const issued = state?.transactions.filter((tx) => tx.type === 'issued') ?? null

  return (
    <ListFrame
      title="Issued vouchers"
      subtitle={
        issued === null ? 'Loading…' : `${issued.length} ${issued.length === 1 ? 'voucher' : 'vouchers'}`
      }
    >
      {issued === null ? (
        <EmptyRow>Loading…</EmptyRow>
      ) : issued.length === 0 ? (
        <EmptyRow>None yet. Vouchers you sell show up here.</EmptyRow>
      ) : (
        issued.map((tx) => <IssuedCouponRow key={tx.id} tx={tx} now={state?.loadedAt ?? 0} />)
      )}
    </ListFrame>
  )
}

/**
 * One issued coupon, in full.
 *
 * Built from the issuance transaction rather than a voucher row, because the
 * merchant does not hold this coupon — they gave it away, and `getVoucherRow`
 * would find nothing. The transaction IS the merchant's copy of the coupon; see
 * `buildIssueTransaction`.
 *
 * Addressed by voucher id, which is the coupon's own identity and what the
 * customer's copy carries too. The row is looked up by the `issued:` key that
 * `buildIssueTransaction` derives from it.
 */
export function IssuedCouponPage() {
  const { voucherId = '' } = useParams()
  const [state, setState] = useState<{ tx: WalletTransaction | null; loadedAt: number } | undefined>(
    undefined,
  )

  useEffect(() => {
    const load = async () => {
      const found = await getTransactionRow(`issued:${voucherId}`)
      setState({ tx: found ? toTransaction(found) : null, loadedAt: Date.now() })
    }
    load()
    return onWalletChanged(load)
  }, [voucherId])

  if (state === undefined) return <Centered>Loading…</Centered>
  if (state.tx === null) return <Centered>No record of this voucher.</Centered>

  const tx = state.tx
  const expired = tx.expiresAt !== undefined && tx.expiresAt <= state.loadedAt

  return (
    <Screen>
      {/* Back to the transaction this coupon came from, which is the only way in. */}
      <BackLink to={`/transaction/${encodeURIComponent(tx.id)}`} label="Transaction" />

      <Panel className="mb-6 p-5">
        <p className="text-amount text-mono-900 dark:text-mono-50">
          {formatFace(tx.amount, { unit: tx.unit, decimals: tx.decimals })}
        </p>
        <p className="truncate text-sm text-mono-500">{tx.memo || 'Voucher issued'}</p>
      </Panel>

      <ListSection title="Voucher">
        {(
          [
            // No "spent / unspent". Whether the customer has used it is not
            // knowable from here — it is bearer value in their wallet — and a
            // status this app cannot stand behind is worse than none.
            ['Status', expired ? 'Expired' : 'Issued'],
            ['Issued', formatDate(tx.at)],
            // Kept even when absent, unlike the rest: "expires 3 Sep" and "never
            // expires" are different facts, and a missing row reads as the second.
            ['Expires', formatDate(tx.expiresAt) || 'No expiry'],
            // Who they are, not their key: face, name, handle. The key itself
            // is one tap away in the raw details below, where a merchant
            // chasing a specific customer can still find it.
            ['Customer', tx.counterparty ? <IdentityInline pubkey={tx.counterparty} /> : undefined],
            ['Voucher id', tx.voucherId],
            // The link back to the movement, in the record itself rather than
            // only in the nav — this is the pairing the two screens are built on.
            ['Transaction id', tx.id],
          ] as Array<[string, React.ReactNode]>
        )
          .filter((e): e is [string, React.ReactNode] => Boolean(e[1]))
          .map(([label, value]) => (
            <DetailRow key={label} label={label} value={value} />
          ))}
      </ListSection>

      <RawDetails
        entries={(
          [
            ['Raw type', tx.type],
            ['Customer pubkey', tx.counterparty],
            ['Face decimals', String(tx.decimals)],
            ['Unit', tx.unit],
          ] as Array<[string, string | undefined]>
        ).filter((e): e is [string, string] => Boolean(e[1]))}
      />
    </Screen>
  )
}

function IssuedCouponRow({ tx, now }: { tx: WalletTransaction; now: number }) {
  // Expiry is the one thing a merchant gets asked about after the sale ("how
  // long do I have?"), so it leads the second line rather than hiding in detail.
  // `now` is the load time, not a fresh clock read — see useMerchantTransactions.
  const expired = tx.expiresAt !== undefined && tx.expiresAt <= now
  // One fetch per customer, not per row: `merchantBranding` caches by pubkey,
  // and a merchant's list is mostly repeat customers.
  const customer = useIdentity(tx.counterparty)

  return (
    <Link
      to={`/transaction/${encodeURIComponent(tx.id)}`}
      className="flex items-center gap-3 p-4 press-row"
    >
      <Clock className={`h-4 w-4 shrink-0 ${expired ? 'text-red-500' : 'text-mono-400'}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-mono-900 dark:text-mono-50">
          {tx.memo || 'Voucher issued'}
        </p>
        <p className="truncate text-sm text-mono-500">
          {/*
            No status beyond expiry, deliberately. Whether the customer has spent
            it is not knowable from here — the coupon is bearer value in their
            wallet — and inventing "active" would be a claim this app cannot
            stand behind.
          */}
          {tx.expiresAt === undefined
            ? `Sold ${formatDate(tx.at)} · no expiry`
            : expired
              ? `Expired ${formatDate(tx.expiresAt)}`
              : `Expires ${formatDate(tx.expiresAt)}`}
          {tx.counterparty ? ` · ${identityLabel(tx.counterparty, customer)}` : ''}
        </p>
      </div>
      <p className="shrink-0 text-right text-mono-900 dark:text-mono-50">
        {formatFace(tx.amount, { unit: tx.unit, decimals: tx.decimals })}
      </p>
      <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" />
    </Link>
  )
}
