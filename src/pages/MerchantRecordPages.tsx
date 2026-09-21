import { useEffect, useMemo, useState } from 'react'
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
  Pagination,
  usePagination,
  Switch,
  present,
} from '../components/ui'
import { listTransactions, onWalletChanged } from '../lib/wallet'
import { toTransaction, type WalletTransaction } from '../lib/transactions'
import { expiringSoon } from '../lib/stats'
import { formatDate, formatFace } from '../lib/format'
import { identityLabel, useIdentity } from '../lib/identity'
import { issuedVoucher, issuedVouchers, type VoucherRecord } from '../lib/issuedVoucher'
import { describeRail, describeWarrant, describeAttestation, type EvidenceLine } from '../lib/issuedVoucherWording'

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
  header,
  children,
  footer,
  back = { to: '/', label: 'Till' },
}: {
  title: string
  subtitle: string
  /**
   * Controls that filter the list, between the heading and the list itself.
   *
   * Above rather than below, because a filter changes what the rows ARE: a
   * reader who meets the list first has already read it under an assumption
   * the control would have corrected.
   */
  header?: React.ReactNode
  children: React.ReactNode
  /** The pagination strip, outside the bordered list it controls. */
  footer?: React.ReactNode
  /**
   * Where "back" goes, which is not the same for every list here.
   *
   * The back link names the screen you came FROM, so it has to follow the way
   * in: the transaction and issued-voucher lists are opened from the till, and
   * the expiring list only exists as the dashboard's "See all". Sending that
   * one to the till would strand a merchant who was reading their dashboard —
   * the wayfinding rule this app's BackLink already follows everywhere else.
   */
  back?: { to: string; label: string }
}) {
  return (
    <Screen>
      <BackLink to={back.to} label={back.label} />
      <PageHeader title={title} subtitle={subtitle} />
      {header}
      <div className="divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800">
        {children}
      </div>
      {footer}
    </Screen>
  )
}

/** Everything that moved, both directions. */
export function MerchantTransactionsPage() {
  const transactions = useMerchantTransactions()?.transactions ?? null
  const { visible, page, pageCount, setPage } = usePagination(transactions ?? [])

  return (
    <ListFrame
      title="Transactions"
      subtitle={
        transactions === null
          ? 'Loading…'
          : `${transactions.length} ${transactions.length === 1 ? 'entry' : 'entries'}`
      }
      footer={<Pagination page={page} pageCount={pageCount} onPage={setPage} />}
    >
      {transactions === null ? (
        <EmptyRow>Loading…</EmptyRow>
      ) : transactions.length === 0 ? (
        <EmptyRow>Nothing yet. Sales and redemptions show up here.</EmptyRow>
      ) : (
        // The same row component the customer screens use, so a movement looks
        // identical wherever it is listed.
        visible.map((tx) => <TransactionListItem key={tx.id} tx={tx} />)
      )}
    </ListFrame>
  )
}

/**
 * The vouchers this merchant put into circulation.
 *
 * **Live ones by default, expired ones on request.** A merchant opens this
 * screen to see what is still out there — the claims customers can walk in
 * with — and a list led by last year's lapsed coupons buries that. But expired
 * vouchers cannot simply be absent either: the customer most likely to present
 * one at a counter is the customer holding one that has run out, and a
 * merchant who cannot find it has no way to see what it was worth or whether
 * any of it was ever claimed.
 *
 * So the filter is a switch rather than a second screen. One list, one place
 * to look, and the default answers the common question without hiding the
 * uncommon one. The count in the subtitle follows the switch, because a
 * heading that counted a set the list is not showing is the kind of quiet
 * disagreement that makes a merchant distrust the whole screen.
 */
export function IssuedCouponsPage() {
  const state = useMerchantTransactions()
  const [includeExpired, setIncludeExpired] = useState(false)

  // Recomputed only when the rows or the filter change, which is a cost
  // saving and NOT a correctness guard.
  //
  // Worth saying plainly, because the tempting reason to memo here is wrong:
  // `usePagination` keeps `page` in `useState` and clamps it against
  // `pageCount`, so a fresh array identity does not move anybody off their
  // page. What it does buy is not re-running a filter and a sort over a
  // history that can hold hundreds of issuances on every unrelated render.
  const issued = useMemo(
    () =>
      state === null
        ? null
        : issuedVouchers(state.transactions, { now: state.loadedAt, includeExpired }),
    [state, includeExpired],
  )

  const { visible, page, pageCount, setPage } = usePagination(issued ?? [])

  // How many are being left out, so the switch says what turning it on buys.
  // Computed rather than inferred from the two list lengths, which would be
  // zero whenever the switch is already on and leave the label saying nothing.
  const expiredCount =
    state === null
      ? 0
      : state.transactions.filter(
          (tx) => tx.type === 'issued' && tx.expiresAt !== undefined && tx.expiresAt <= state.loadedAt,
        ).length

  return (
    <ListFrame
      title="Vouchers"
      subtitle={
        issued === null
          ? 'Loading…'
          : `${issued.length} ${issued.length === 1 ? 'voucher' : 'vouchers'}` +
            (includeExpired ? '' : ' still valid')
      }
      header={
        // Rendered only when there ARE expired vouchers. A switch that changes
        // nothing teaches a merchant that this control does nothing, and its
        // presence is itself the signal that there is something behind it.
        expiredCount > 0 ? (
          <div className="mb-4">
            <Switch
              label="Include expired"
              hint={`${expiredCount} ${expiredCount === 1 ? 'voucher has' : 'vouchers have'} run out`}
              checked={includeExpired}
              onChange={(next) => {
                setIncludeExpired(next)
                // Back to the first page: the list underneath is a different
                // set now, and page 3 of the old one is page 3 of nothing in
                // particular.
                setPage(1)
              }}
            />
          </div>
        ) : undefined
      }
      footer={<Pagination page={page} pageCount={pageCount} onPage={setPage} />}
    >
      {issued === null ? (
        <EmptyRow>Loading…</EmptyRow>
      ) : issued.length === 0 ? (
        <EmptyRow>
          {expiredCount > 0 && !includeExpired
            ? 'Nothing still valid. Turn on “Include expired” to see the ones that have run out.'
            : 'None yet. Vouchers you sell show up here.'}
        </EmptyRow>
      ) : (
        visible.map((tx) => <IssuedCouponRow key={tx.id} tx={tx} now={state?.loadedAt ?? 0} />)
      )}
    </ListFrame>
  )
}

/**
 * Every voucher about to run out, soonest first.
 *
 * The dashboard shows the three most urgent and links here for the rest. This
 * is the same set from the same function — `expiringSoon` — rather than a
 * second filter written to match, because two definitions of "expiring soon"
 * that drift apart would have the dashboard's count disagreeing with the list
 * it links to.
 *
 * Already-expired vouchers are absent, which is `expiringSoon`'s rule and the
 * right one: nothing can be done about them, and mixing them in buries the ones
 * a merchant could still ring a customer about. They are in "Issued vouchers",
 * marked expired.
 */
export function ExpiringVouchersPage() {
  const state = useMerchantTransactions()
  const expiring =
    state === null ? null : expiringSoon(state.transactions, { now: state.loadedAt })
  const { visible, page, pageCount, setPage } = usePagination(expiring ?? [])

  return (
    <ListFrame
      title="Expiring soon"
      subtitle={
        expiring === null
          ? 'Loading…'
          : `${expiring.length} ${expiring.length === 1 ? 'voucher' : 'vouchers'} within 7 days`
      }
      // Reached only from the dashboard's "See all".
      back={{ to: '/merchant/dashboard', label: 'Dashboard' }}
      footer={<Pagination page={page} pageCount={pageCount} onPage={setPage} />}
    >
      {expiring === null ? (
        <EmptyRow>Loading…</EmptyRow>
      ) : expiring.length === 0 ? (
        // Reachable by typing the URL or by keeping the tab open until the last
        // one lapses, so it needs a real answer rather than an empty box.
        <EmptyRow>Nothing expiring in the next 7 days.</EmptyRow>
      ) : (
        // The same row as the issued list: an expiring voucher IS an issued
        // voucher, and its row already leads with the expiry date.
        visible.map((tx) => <IssuedCouponRow key={tx.id} tx={tx} now={state?.loadedAt ?? 0} />)
      )}
    </ListFrame>
  )
}

/**
 * One issued voucher, in full: what it was worth, what has come back against
 * it, and what stands behind it.
 *
 * Built from the issuance transaction rather than a voucher row, because the
 * merchant does not hold this coupon — they gave it away, and `getVoucherRow`
 * would find nothing. The transaction IS the merchant's copy of the coupon; see
 * `buildIssueTransaction`.
 *
 * Addressed by voucher id, which is the coupon's own identity and what the
 * customer's copy carries too.
 *
 * **It reads the WHOLE history rather than one row**, which is the change that
 * makes this screen answer the question it is opened with. "How much of this
 * has been claimed" is a sum over every incoming row sharing the voucher id —
 * a coupon is spent down rather than used up, so one issuance legitimately has
 * several claims against it — and a single-row fetch can only ever answer what
 * was issued. See `issuedVoucher.ts` for the join.
 */
export function IssuedCouponPage({ pubkey }: { pubkey: string }) {
  const { voucherId = '' } = useParams()
  const state = useMerchantTransactions()

  const voucher = useMemo(
    () =>
      state === null
        ? undefined
        : issuedVoucher(state.transactions, voucherId, {
            now: state.loadedAt,
            // The STALL's key. Warrants are signed by the stall and `issuerId`
            // names it, so checking against anything else — the ledger key in
            // particular — would report every honest sale as a mismatch.
            stallPubkey: pubkey,
          }),
    [state, voucherId, pubkey],
  )

  if (state === null) return <Centered>Loading…</Centered>
  // "Not in my records", never "not issued": a coupon sold on another terminal
  // is not in this history either, and neither is one from a device whose
  // records have not been restored yet.
  if (voucher === undefined) return <Centered>No record of this voucher.</Centered>

  return <VoucherRecordDetail voucher={voucher} />
}

function VoucherRecordDetail({ voucher }: { voucher: VoucherRecord }) {
  const { row, expired, claimedMinor, outstandingMinor, claims } = voucher
  const money = (minor: number) => formatFace(minor, { unit: row.unit, decimals: row.decimals })

  const rail = describeRail(voucher.rail)
  const warrant = describeWarrant(voucher.warrantVerdict)
  const attestation = describeAttestation(voucher.attestationVerdict)

  return (
    <Screen>
      {/* The list this voucher lives on, which is now the way in — from the
          menu, from the dashboard's expiring section, or from a sibling. The
          transaction it came from is still reachable, one row down. */}
      <BackLink to="/merchant/coupons" label="Vouchers" />

      <Panel className="mb-6 p-5">
        <p className="text-amount text-mono-900 dark:text-mono-50">{money(row.amount)}</p>
        <p className="truncate text-sm text-mono-500">{row.memo || 'Voucher issued'}</p>
      </Panel>

      {/*
        What has come back, as the first thing after the amount.

        This is the question the screen is opened with, and it is a genuinely
        new answer rather than a restatement: the issuance row says what went
        out, and only the claims say what came home. Both figures are shown
        rather than just one, because "300 claimed" and "700 still out there"
        are different things to a merchant — the first is takings, the second
        is a liability they may still have to honour.
      */}
      <ListSection title="Claimed">
        <DetailRow label="Claimed so far" value={money(claimedMinor)} />
        <DetailRow
          label="Still outstanding"
          value={
            // Floored at zero in `issuedVoucher`, so this never reads as the
            // stall being owed money by a coupon it issued.
            <span className={outstandingMinor === 0 ? 'text-mono-500' : 'text-mono-900 dark:text-mono-50'}>
              {money(outstandingMinor)}
            </span>
          }
        />
      </ListSection>

      {/*
        The movements themselves, so the total above can be checked rather than
        only believed. Present only when there are any: an empty box under a
        "0.00 claimed" line says the same thing twice, and the line above
        already answers it.
      */}
      {claims.length > 0 ? (
        <ListSection title={claims.length === 1 ? 'Claim' : 'Claims'}>
          {claims.map((tx) => (
            <TransactionListItem key={tx.id} tx={tx} />
          ))}
        </ListSection>
      ) : null}

      <ListSection title="Voucher">
        {present<React.ReactNode>([
          // Expiry only. Whether the customer has spent what is left is not
          // knowable from here beyond what came back to this device, and the
          // claimed figure above is the honest version of that question.
          ['Status', expired ? 'Expired' : 'Issued'],
          ['Issued', formatDate(row.at)],
          // Kept even when absent, unlike the rest: "expires 3 Sep" and "never
          // expires" are different facts, and a missing row reads as the second.
          ['Expires', formatDate(row.expiresAt) || 'No expiry'],
          // Who they are, not their key: face, name, handle. The key itself
          // is one tap away in the raw details below, where a merchant
          // chasing a specific customer can still find it.
          ['Customer', row.counterparty ? <IdentityInline pubkey={row.counterparty} /> : undefined],
          ['Voucher id', row.voucherId],
        ]).map(([label, value]) => (
          <DetailRow key={label} label={label} value={value} />
        ))}
        {/*
          The movement this coupon came from, as a LINK rather than as an id.

          The two screens are a pair — a voucher and the transaction that put
          it into the world — and that pairing used to be the way in: the
          detail screen was reached from the transaction, and its back arrow
          went there. Now the voucher is reached from its own list, so without
          this the transaction became unreachable from the record it belongs
          to, and the id underneath was a string to read rather than somewhere
          to go.
        */}
        <Link
          to={`/transaction/${encodeURIComponent(row.id)}`}
          className="flex items-center justify-between gap-4 p-4 press-row"
        >
          <span className="shrink-0 text-sm text-mono-500">Transaction</span>
          <span className="flex min-w-0 items-center gap-1 text-right text-mono-900 dark:text-mono-50">
            The sale this came from
            <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" />
          </span>
        </Link>
      </ListSection>

      {/*
        The evidence, as three separate lines that are never collapsed.

        They answer three different questions — how it was paid for, whether
        this stall authorised issuing it, and whether the customer said money
        arrived — and merging any two would let a merchant read authorisation
        as proof of payment. `reconcileIssuance.ts` keeps the same separation
        for the same reason.
      */}
      <ListSection title="How it was paid for">
        <EvidenceRow label="Payment" line={rail} />
        <EvidenceRow label="Authorised" line={warrant} />
        <EvidenceRow label="Customer receipt" line={attestation} />
      </ListSection>

      {/*
        The rest of the sale, when there was more than this coupon.

        One Sell action can mint several coupons — a large face value is split
        server-side — and a merchant holding one wants to know which sale it
        came from and whether the rest is accounted for. Absent for the
        ordinary single-coupon sale, which is its own whole sale and needs no
        section saying so.
      */}
      {voucher.sale.length > 1 ? (
        <ListSection title="The rest of this sale">
          {!voucher.saleComplete ? (
            <EmptyRow>
              Some coupons from this sale are missing from these records. That can mean a sale
              that failed part-way, or history restored in pieces — worth checking against the
              customer.
            </EmptyRow>
          ) : null}
          {voucher.sale
            .filter((part) => part.voucherId !== row.voucherId)
            .map((part) => (
              <Link
                key={part.id}
                to={`/merchant/coupon/${encodeURIComponent(part.voucherId ?? '')}`}
                className="flex items-center gap-3 p-4 press-row"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-mono-900 dark:text-mono-50">
                    {part.memo || 'Voucher issued'}
                  </p>
                  <p className="truncate text-sm text-mono-500">Issued {formatDate(part.at)}</p>
                </div>
                <p className="shrink-0 text-right text-mono-900 dark:text-mono-50">
                  {formatFace(part.amount, { unit: part.unit, decimals: part.decimals })}
                </p>
                <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" />
              </Link>
            ))}
        </ListSection>
      ) : null}

      <RawDetails
        entries={present<React.ReactNode>([
          ['Raw type', row.type],
          // The link back to the movement, in the record itself rather than
          // only in the nav — this is the pairing the two screens are built on.
          ['Transaction id', row.id],
          ['Customer pubkey', row.counterparty],
          ['Face decimals', String(row.decimals)],
          ['Unit', row.unit],
          // The sale's own identity, from inside the signature. It is what
          // groups the parts of a split sale and what a customer's receipt
          // binds to, so it is the handle for matching the two by hand.
          [
            'Sale nonce',
            voucher.warrant.state === 'present' ? voucher.warrant.saleNonce : undefined,
          ],
          // The signed bytes themselves, so a merchant's own record can be
          // re-checked by something that is not this app. Without them the
          // verification above is one more thing to take on trust.
          ['Issuance warrant', row.issuanceWarrant],
          ['Customer attestation', row.cashAttestation],
        ])}
      />
    </Screen>
  )
}

/**
 * One line of evidence, with what it does and does not establish underneath.
 *
 * The caveat is on the screen rather than behind a tap, because every line
 * here is one a reader could take for more than it says — "signed by this
 * stall" reads as "and I was paid" to anyone not thinking about it. A sentence
 * costs a line of screen; the misreading costs a merchant a dispute.
 */
function EvidenceRow({ label, line }: { label: string; line: EvidenceLine }) {
  return (
    <div className="p-4">
      <div className="flex items-baseline justify-between gap-4">
        <span className="shrink-0 text-sm text-mono-500">{label}</span>
        <span
          className={`min-w-0 text-right ${
            line.alarming
              ? 'font-medium text-red-600 dark:text-red-400'
              : 'text-mono-900 dark:text-mono-50'
          }`}
        >
          {line.label}
        </span>
      </div>
      {line.detail ? (
        <p className="mt-1 text-sm leading-relaxed text-mono-500">{line.detail}</p>
      ) : null}
    </div>
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
      // The VOUCHER, not the transaction that issued it. The row is a coupon
      // and the question behind it is "what happened to this coupon" — how
      // much came back, what stands behind it — which is a voucher question.
      // The issuing transaction is still one tap further in, in the record's
      // own details, for the reader who wants the movement rather than the
      // coupon.
      to={`/merchant/coupon/${encodeURIComponent(tx.voucherId ?? '')}`}
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
