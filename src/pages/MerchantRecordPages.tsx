import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  MinusCircle,
  type LucideIcon,
} from 'lucide-react'

import {
  Screen,
  BackLink,
  PageHeader,
  EmptyRow,
  HistoryListItem,
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
} from '../components/ui'
import { present } from '../lib/detailRows'
import { CopyReferenceButton, PaymentReferenceBlock } from '../components/PaymentReference'
import { cardReferenceOf } from '../lib/paymentReference'
import { onWalletChanged } from '../lib/wallet'
import { handlerFor } from '../lib/terminalAttribution'
import { onRosterView } from '../lib/terminalRoster'
import { collectTillSalesForOwner } from '../lib/tillSalesNet'
import { repairedTransactions } from '../lib/redemptionLedger'
import type { WalletTransaction } from '../lib/transactions'
import { entryKey, groupHistory } from '../lib/historyGroups'
import { expiringSoon } from '../lib/stats'
import { formatDate, formatFace } from '../lib/format'
import { identityLabel, useIdentity } from '../lib/identity'
import {
  isVoucherIssuance,
  issuedVoucher,
  issuedVouchers,
  type VoucherRecord,
} from '../lib/issuedVoucher'
import { cashbackClaimLabel, refreshCashbackClaims } from '../lib/cashbackVouchers'
import {
  describeRail,
  describeWarrant,
  describeAttestation,
  describeCashbackKind,
  describeCashbackClaim,
  type EvidenceLine,
  type EvidenceTone,
} from '../lib/issuedVoucherWording'

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
      // Repaired (#145): the claimed figure must read the same rows the
      // till's ceiling does, or the two disagree about what is left.
      const rows = await repairedTransactions()
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
  // One line per payment, as on the customer's list (#106). Display only: the
  // claims and request settlement read the flat rows, never these entries.
  const entries = useMemo(() => (transactions ? groupHistory(transactions) : null), [transactions])
  const { visible, page, pageCount, setPage } = usePagination(entries ?? [])

  return (
    <ListFrame
      title="Transactions"
      subtitle={
        entries === null
          ? 'Loading…'
          : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`
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
        visible.map((entry) => (
          <HistoryListItem key={entryKey(entry)} entry={entry} />
        ))
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
export function IssuedCouponsPage({ stallPubkey }: { stallPubkey?: string } = {}) {
  const state = useMerchantTransactions()
  // A till's sales arrive by DM (#160 phase 6, wallet#202): look for new ones whenever this list
  // opens, so a sale made on a till shows here without a re-login.
  useEffect(() => {
    if (stallPubkey) void collectTillSalesForOwner(stallPubkey)
  }, [stallPubkey])
  // The till names come from the roster, which the login sync may merge in after this list opened
  // (on a restored phone, #160 phase 6 E4): re-render when it does.
  const [, setRosterRev] = useState(0)
  useEffect(() => {
    if (!stallPubkey) return
    return onRosterView((stall) => {
      if (stall === stallPubkey) setRosterRev((n) => n + 1)
    })
  }, [stallPubkey])
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

  // Once per opening, not on every reload. The status write-back fires the
  // wallet's change event, which reloads `state`, so without the ref one
  // refresh would trigger the next. Only open cashback rows are asked.
  const refreshed = useRef(false)
  useEffect(() => {
    if (state === null || refreshed.current) return
    refreshed.current = true
    void refreshCashbackClaims(state.transactions)
  }, [state])

  // How many are being left out, so the switch says what turning it on buys.
  // Computed rather than inferred from the two list lengths, which would be
  // zero whenever the switch is already on and leave the label saying nothing.
  const expiredCount =
    state === null
      ? 0
      : state.transactions.filter(
          (tx) =>
            isVoucherIssuance(tx) &&
            Boolean(tx.voucherId) &&
            tx.expiresAt !== undefined &&
            tx.expiresAt <= state.loadedAt,
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
            : 'None yet. Vouchers you sell and cashback you issue show up here.'}
        </EmptyRow>
      ) : (
        visible.map((tx) => <IssuedCouponRow key={tx.id} tx={tx} now={state?.loadedAt ?? 0} stallPubkey={stallPubkey} />)
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

/** Exported for its page test; routed through `IssuedCouponPage`. */
export function VoucherRecordDetail({ voucher }: { voucher: VoucherRecord }) {
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

      {/*
        The face value and what has become of it, as ONE panel.

        They were two — a hero with the amount, then a list section of two
        label/value rows — and splitting them made the reader do the
        arithmetic that is the whole question. "500 of 2,000 claimed" is a
        single fact about a single coupon, so it is a single surface, with the
        proportion drawn rather than described. Simplicity in the sense the
        principle actually means: fewer things standing between a merchant and
        the answer, not fewer pixels.

        The face value keeps the hero treatment and the claimed figure sits
        under it in the body size, because the coupon's worth is what a
        customer will say out loud at the counter and what every other screen
        leads with. Breaking that would cost the spatial consistency of the
        amount always being the biggest thing on a record.
      */}
      <Panel className="mb-6 p-5">
        <p className="text-amount text-mono-900 dark:text-mono-50">{money(row.amount)}</p>
        <p className="truncate text-sm text-mono-500">{row.memo || 'Voucher issued'}</p>
        {cashbackClaimLabel(row) ? (
          <p className="text-sm text-mono-500">Cashback code · {cashbackClaimLabel(row)}</p>
        ) : null}

        <ClaimedBar
          claimedMinor={claimedMinor}
          outstandingMinor={outstandingMinor}
          faceMinor={row.amount}
          expired={expired}
          money={money}
        />
      </Panel>

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
          /*
            Expiry only. Whether the customer has spent what is left is not
            knowable from here beyond what came back to this device, and the
            claimed figure above is the honest version of that question.

            Carries the SAME red clock the list row shows, because a merchant
            arrives here by tapping that row and the mark they tapped has to
            be the mark they land on. A state that is loud on one screen and a
            plain word on the next reads as two different states — the spatial
            consistency rule applied to iconography rather than to motion.
          */
          [
            'Status',
            expired ? (
              <span className="flex items-center gap-1.5 text-mono-900 dark:text-mono-50">
                Expired
                <Clock className="h-[1em] w-[1em] shrink-0 text-red-500" aria-hidden="true" />
              </span>
            ) : (
              'Issued'
            ),
          ],
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
            {row.type === 'cashback' ? 'The cashback this came from' : 'The sale this came from'}
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
      {/*
        "What stands behind this", not "How it was paid for".

        The old heading named only the first of its three rows, so the two
        under it read as answers to a question they were not answering — a
        warrant is about authorisation and an attestation is about a customer's
        word, neither of which is a payment method. A section heading that
        over-claims is worse than a vague one: it tells the reader they have
        understood when they have not.
      */}
      <ListSection title="What stands behind this">
        {/* A cashback is not a Sell sale (#155): no rail, no customer
            receipt. What it is, whether it was claimed, and who signed.
            "Claimed", not "Collected": the word the list, the portal and the
            issue use, and not a near-twin of the Sell "Not collected". */}
        {row.type === 'cashback' ? (
          <>
            <EvidenceRow label="What it is" line={describeCashbackKind()} />
            <EvidenceRow
              label="Claimed"
              line={describeCashbackClaim(
                { status: row.cashbackStatus, claimedAt: row.claimedAt, expired },
                formatDate,
              )}
            />
            <EvidenceRow label="Authorised" line={warrant} />
          </>
        ) : (
          <>
            <EvidenceRow label="Paid" line={rail} />
            {/* The processor's id, copyable and beside the amount and date a
                merchant on an Express dashboard needs to find it (#267). */}
            {voucher.rail.kind === 'card' && voucher.rail.reference ? (
              <PaymentReferenceBlock
                reference={voucher.rail.reference}
                amount={money(row.amount)}
                date={formatDate(row.at)}
              />
            ) : null}
            <EvidenceRow label="Authorised" line={warrant} />
            <EvidenceRow label="Customer receipt" line={attestation} />
          </>
        )}
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
 * How much of a coupon has come home, drawn rather than described.
 *
 * ## Why a bar at all
 *
 * "500 claimed" and "1,500 outstanding" as two rows make the reader hold two
 * numbers and a face value in their head to answer the question they opened
 * the screen with. A proportion is the one thing a bar says faster than a
 * sentence, and this is a genuine proportion of a known whole — not a
 * decorative gauge over an invented maximum.
 *
 * ## Never the only signal
 *
 * Both figures are written out underneath, at full precision and in the
 * coupon's own currency. The bar is the fast path; the words are the fact.
 * That ordering is the same one `ValidationBadge` sets out, and it is what
 * keeps this readable with a screen reader, in bright sun, and for anyone who
 * cannot separate the two fills by colour.
 *
 * `aria-hidden` on the bar itself for exactly that reason: it restates the
 * figures beside it, and a screen reader announcing a decorative
 * approximation of a number it is about to read exactly is noise.
 */
function ClaimedBar({
  claimedMinor,
  outstandingMinor,
  faceMinor,
  expired,
  money,
}: {
  claimedMinor: number
  outstandingMinor: number
  faceMinor: number
  expired: boolean
  money: (minor: number) => string
}) {
  // Guarded against a zero face value, which would be a 0/0 sale but is not
  // this component's business to report. Clamped at 100 because a coupon CAN
  // come back for more than one row recorded going out — see the floor on
  // `outstandingMinor` — and a bar overflowing its track would read as a
  // rendering fault rather than as the data oddity it is.
  const claimedPercent =
    faceMinor > 0 ? Math.min(100, Math.round((claimedMinor / faceMinor) * 100)) : 0

  return (
    <div className="mt-4">
      {/*
        A hairline track with a filled portion, not a chart. 6px is enough to
        read a proportion at a glance and small enough to stay subordinate to
        the amount above it, which is still the thing the eye lands on first.
      */}
      <div
        className="flex h-1.5 overflow-hidden rounded-full bg-mono-200 dark:bg-mono-800"
        aria-hidden="true"
      >
        <div
          // Green for value that has come home, the same green this app uses
          // for incoming money everywhere else — a claimed coupon and a
          // payment arriving are the same event from the stall's side, so they
          // speak with one voice.
          //
          // A width transition, so a claim landing by DM while the screen is
          // open GROWS the bar rather than teleporting it. 300ms on the curve
          // the rest of the app uses; `motion-reduce` drops the movement and
          // keeps the value, which is what the setting actually asks for.
          className="h-full rounded-full bg-green-600 transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
          style={{ width: `${claimedPercent}%` }}
        />
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-4">
        <span className="text-sm text-mono-500">
          {/* The claimed figure leads, because it is the new fact. The face
              value is repeated as the denominator rather than left to the
              reader's memory of the line above — "of 2,000" is what makes the
              first number mean something. */}
          <span className="font-medium text-mono-900 dark:text-mono-50">
            {money(claimedMinor)}
          </span>{' '}
          claimed
        </span>
        {/*
          The remainder, in the merchant's own terms. An expired coupon's
          remainder is not a liability any more — nobody can walk in with it —
          so the word changes rather than the number being hidden: "lapsed"
          says what happened to the value, where "outstanding" would overstate
          what the stall still owes.
        */}
        <span className="text-right text-sm text-mono-500">
          {money(outstandingMinor)} {expired ? 'lapsed' : 'outstanding'}
        </span>
      </div>
      {/*
        What the figures above are counted from, said where they are read
        (#95, #97, ADR 0015). Small and grey: it qualifies the numbers, it is
        not a warning about them.
      */}
      <p className="mt-1 text-xs text-mono-500">
        As recorded on this device. Claims taken on your other devices show here once this one syncs.
      </p>
    </div>
  )
}

/**
 * The glyph and colour for each evidence tone.
 *
 * **Colour is never the only signal**, which is the rule `ValidationBadge`
 * states and the reason each tone carries its own SHAPE: a tick, a dash, a
 * warning triangle. The line still reads for anyone who cannot separate green
 * from grey from red, in sun at a stall, or in a greyscale screenshot.
 *
 * `neutral` is a MINUS rather than a question mark, and grey rather than
 * amber. "Nothing to check" is the resting state of most of a stall's history
 * — every sale before warrants shipped, every terminal sale, every sale with
 * no customer receipt — and a warning glyph on all of them would train a
 * merchant to skim the one row that matters.
 */
const EVIDENCE_TONE: Record<EvidenceTone, { Icon: LucideIcon; className: string }> = {
  confirmed: { Icon: CheckCircle2, className: 'text-green-600' },
  // mono-500, not mono-400: the same contrast floor ValidationBadge measured
  // for a non-text graphic carrying meaning.
  neutral: { Icon: MinusCircle, className: 'text-mono-500' },
  alarming: { Icon: AlertTriangle, className: 'text-red-500' },
}

/**
 * One line of evidence, with what it does and does not establish underneath.
 *
 * The caveat is on the screen rather than behind a tap, because every line
 * here is one a reader could take for more than it says — "signed by this
 * stall" reads as "and I was paid" to anyone not thinking about it. A sentence
 * costs a line of screen; the misreading costs a merchant a dispute.
 *
 * The glyph sits on the TRAILING edge beside its value, which is where this
 * app already puts the mark that qualifies a value (see the menu rows, and
 * `TransactionListItem`'s badge beside the label it qualifies). Leading-edge
 * glyphs would make three icons into a column the eye reads as a list of
 * statuses rather than as three separate answers.
 */
function EvidenceRow({ label, line }: { label: string; line: EvidenceLine }) {
  const { Icon, className: tone } = EVIDENCE_TONE[line.tone]

  return (
    <div className="p-4">
      <div className="flex items-baseline justify-between gap-4">
        <span className="shrink-0 text-sm text-mono-500">{label}</span>
        <span
          className={`flex min-w-0 items-baseline gap-1.5 text-right ${
            line.tone === 'alarming'
              ? 'font-medium text-red-600 dark:text-red-400'
              : 'text-mono-900 dark:text-mono-50'
          }`}
        >
          {line.label}
          {/* 1em, so the mark tracks the user's text size rather than
              shrinking into insignificance at large Dynamic Type settings. */}
          <Icon className={`h-[1em] w-[1em] shrink-0 self-center ${tone}`} aria-hidden="true" />
        </span>
      </div>
      {/* `leading-relaxed` because this is a sentence rather than a field:
          body copy wants looser leading than the dense label/value rows
          around it, which is the leading-tracks-size-inversely rule. */}
      {line.detail ? (
        <p className="mt-1 text-sm leading-relaxed text-mono-500">{line.detail}</p>
      ) : null}
    </div>
  )
}

function IssuedCouponRow({ tx, now, stallPubkey }: { tx: WalletTransaction; now: number; stallPubkey?: string }) {
  // Expiry is the one thing a merchant gets asked about after the sale ("how
  // long do I have?"), so it leads the second line rather than hiding in detail.
  // `now` is the load time, not a fresh clock read — see useMerchantTransactions.
  const expired = tx.expiresAt !== undefined && tx.expiresAt <= now
  // One fetch per customer, not per row: `merchantBranding` caches by pubkey,
  // and a merchant's list is mostly repeat customers.
  const customer = useIdentity(tx.counterparty)
  const claimLabel = cashbackClaimLabel(tx)
  // A card sale's processor reference, compact and copyable (#267). The copy
  // button sits OUTSIDE the row's link: a button nested in an anchor is
  // invalid HTML and a tap on it would also navigate.
  const cardRef = tx.type === 'cashback' ? undefined : cardReferenceOf(tx.issuanceWarrant)

  const link = (
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
          {/* A cashback's claim state comes from the portal, which does know it. */}
          {claimLabel ? ` · ${claimLabel}` : ''}
          {/* Which till sold it (#160 phase 6, F3), named from the roster, "(no longer in
              service)" once revoked. Absent on the owner's own sales. */}
          {tx.terminalPubkey && stallPubkey
            ? ` · Sold on ${handlerFor({ terminalPubkey: tx.terminalPubkey }, stallPubkey).label}`
            : ''}
        </p>
      </div>
      <p className="shrink-0 text-right text-mono-900 dark:text-mono-50">
        {formatFace(tx.amount, { unit: tx.unit, decimals: tx.decimals })}
      </p>
      <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" />
    </Link>
  )

  if (!cardRef) return link
  return (
    <div>
      {link}
      <div className="-mt-3 flex items-center gap-1 px-4 pb-3 pl-11 text-xs text-mono-500">
        <span>Card</span>
        <CopyReferenceButton reference={cardRef} compact />
      </div>
    </div>
  )
}
