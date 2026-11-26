import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { ChevronRight, Info } from 'lucide-react'
import type { VoucherRow } from '@imani/wallet-storage'

import { handlerFor } from '../lib/terminalAttribution'

import {
  Screen,
  BackLink,
  Panel,
  ListSection,
  DetailRow,
  RawDetails,
  Centered,
  IdentityInline,
  ValidationBadge,
  Button,
} from '../components/ui'
import { present } from '../lib/detailRows'
import {
  getVoucherRow,
  getTransactionRow,
  listTransactions,
  onWalletChanged,
  recheckCashbackRowOnOpen,
  recordCashbackStatus,
} from '../lib/wallet'
import { formatFace, formatDate } from '../lib/format'
import { humanName } from '../lib/identity'
import { spendSourceLabel } from '../lib/spendSource'
import {
  VALIDATION_SUMMARY,
  hasValidationClaim,
  hasPublishedAttestation,
  validationStatus,
  type ValidationStatus,
} from '../lib/validationStatus'
import { cashlinkReturnsOf, returnOfLabel, otherParty, toTransaction, transactionLabel, type WalletTransaction } from '../lib/transactions'
import { RefusedCouponsNote } from '../components/ui/RefusedCouponsNote'
import { fetchCashbackLink, useCashbackStatus } from '../lib/cashback'
import { formatCashbackLink } from '../lib/claimLink'
import { CancelCashback, ClaimLinkPanel } from '../components/CashbackClaimLink'
import { GiftLinkSection } from '../components/GiftLinkSection'
import { ReceiptSection } from '../components/ReceiptSection'
import { BACK_HOME, NO_LONGER_HELD } from '../lib/voucherRowCopy'

/**
 * One record, in full.
 *
 * Both screens follow the same shape: the amount as the hero, a short summary of
 * what a person would want to know, then the technical record collapsed behind
 * "Details". Entries with no value are dropped rather than shown as an em-dash —
 * a DM-received coupon has no expiry and no memo, so a fixed field list would be
 * mostly blanks.
 */

/**
 * An old voucher link (`/coupon/:tokenId`: a bell entry, a bookmark, a shared screenshot's URL).
 *
 * The voucher detail screen is gone: a voucher opens in place in its stall's list, which shows
 * everything a holder acts on. So the link goes to that list with the voucher open
 * (`?open=<token id>`). A voucher with no issuer, or one no longer in the wallet, has no list to
 * open in, and says so with a way home rather than a blank screen.
 */
export function CouponRedirect() {
  const { tokenId = '' } = useParams()
  const [row, setRow] = useState<VoucherRow | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    getVoucherRow(tokenId).then((found) => live && setRow(found))
    return () => {
      live = false
    }
  }, [tokenId])

  if (row === undefined) return <Centered>Loading…</Centered>
  if (row === null || !row.issuer_id) {
    return (
      <Screen>
        <BackLink to="/" label={BACK_HOME} />
        <Centered>{NO_LONGER_HELD}</Centered>
      </Screen>
    )
  }
  return (
    <Navigate
      replace
      to={`/merchants/${encodeURIComponent(row.issuer_id)}/vouchers?open=${encodeURIComponent(row.token_id)}`}
    />
  )
}

/**
 * What was checked about an arriving coupon.
 *
 * Deliberately a list of claims rather than one badge. A single tick next to a
 * value derived from `issuance_ratio` would overstate what was verified — that
 * field is not covered by the signature on any voucher issued so far — and a
 * badge that claims more than it checked makes the wallet less trustworthy while
 * looking like it does the opposite. Each line says one thing that is true.
 *
 * Absent validation means the row predates verification. It reads as "not
 * checked", never as a pass: silence must not be mistaken for approval.
 *
 * `legacyCanonical` is not surfaced. It is true for every voucher issued to
 * date, so rendering it would mark the entire existing estate as suspect and
 * tell a merchant at a stall nothing they can act on. It comes back when the
 * canonicalizer migration makes it a real distinction between coupons.
 */
function ValidationSection({ tx }: { tx: WalletTransaction }) {
  const [explaining, setExplaining] = useState(false)

  // Only meaningful for coupons arriving here. An outgoing row is this wallet's
  // own act, and plain ecash carries no issuer claim to check.
  if (!hasValidationClaim(tx)) return null

  const v = tx.validation
  const status = validationStatus(v)

  return (
    <>
      <ListSection
        title="Checks"
        // The explainer sits in the section header rather than on a row,
        // because it explains the whole section — putting it beside "Issuer"
        // would promise an answer about that line alone. Grouping and mapping:
        // a control belongs next to what it affects, which is why this is an
        // `adornment` (beside the title) and not an `action` (at the far edge,
        // where "See all" lives and where an (i) would refer to nothing).
        adornment={
          <button
            type="button"
            onClick={() => setExplaining(true)}
            // 44px minimum target, per Apple's touch guidance, achieved with
            // negative margin so the hit area is generous without the glyph
            // pushing the header taller than its text.
            className="pressable -m-2.5 rounded-full p-2.5 text-mono-400 outline-none ring-mono-400 transition-colors hover:text-mono-600 focus-visible:ring-2 dark:hover:text-mono-300"
            aria-label="What do these checks mean?"
          >
            <Info className="h-[1.125rem] w-[1.125rem]" />
          </button>
        }
      >
        <DetailRow
          label="Issuer"
          value={
            // The same badge as the list row, so the mark someone tapped is the
            // mark they arrive at. Spatial consistency, applied to iconography.
            <span className="flex items-center gap-2">
              <ValidationBadge validation={v} />
              <span className="text-mono-900 dark:text-mono-50">
                {v
                  ? v.signatureValid
                    ? 'Signature verified'
                    : 'Signature did not verify'
                  : 'Not checked'}
              </span>
            </span>
          }
        />
        {v?.cappedAtFaceValue ? (
          <DetailRow
            label="Value"
            value={`Limited to the ${formatFace(v.signedFaceValue, {
              unit: tx.unit,
              decimals: tx.decimals,
            })} originally issued`}
          />
        ) : null}
        {/*
          The public half of the record (DEV-246). Present only once a relay
          took it, because `attestationEventId` is written only then — a row
          carries `attestationNullifier` on EVERY redemption, so keying on the
          nullifier would read "published" on plain ecash and on every
          customer's row alike.

          Absent rather than a "not published" line: every redemption from
          before this feature would carry it, and a merchant at a stall can do
          nothing about a record that is missing — the sweep on Settings >
          Redemption ledger is what closes those, and it says so there. A
          permanent negative on a completed sale reads as a fault.

          The DATE is the event's, not the row's. A sweep can publish months
          after the sale, and this line dates the publication.
        */}
        {hasPublishedAttestation(tx) ? (
          <DetailRow
            label="Record"
            value={
              tx.attestationAt
                ? `Published to the public ledger · ${formatDate(tx.attestationAt)}`
                : 'Published to the public ledger'
            }
          />
        ) : null}
      </ListSection>

      {explaining ? (
        <ValidationExplainer status={status} onClose={() => setExplaining(false)} />
      ) : null}
    </>
  )
}

/**
 * What the checks on this screen actually mean.
 *
 * Written for the person holding the phone, not for the person who wrote the
 * signature code: it says what was checked, what it does and does not prove,
 * and what to do about it. A merchant at a stall with a queue behind them needs
 * an answer in one read.
 *
 * The leading paragraph is about THIS coupon's state, because a dialog that
 * opens with generic theory makes the reader hunt for the sentence that applies
 * to them. Specific first, general second.
 *
 * A native `<dialog>`, matching HandleDialog on the profile screen: top layer,
 * backdrop, focus containment, Escape and focus restoration all come from the
 * platform, and a hand-rolled overlay would get at least three of them wrong.
 */
function ValidationExplainer({
  status,
  onClose,
}: {
  status: ValidationStatus
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Dim to focus: a modal task pushes everything else back.
      className="materialize m-auto w-[calc(100%-2.5rem)] max-w-sm rounded-[20px] bg-transparent p-0 backdrop:bg-mono-950/50 backdrop:backdrop-blur-sm"
      // A click landing on the element itself rather than on the card is a
      // click on the backdrop, which is a click outside.
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
      aria-labelledby="validation-explainer-title"
    >
      <div className="material flex flex-col gap-4 rounded-[20px] p-5 shadow-xl shadow-mono-950/20 ring-1 ring-mono-900/5 dark:ring-mono-50/10">
        <div className="flex flex-col gap-1">
          {/*
            Tighter tracking as the size goes up — large text reads too loose at
            default spacing. Leading tightens with it.
          */}
          <h2
            id="validation-explainer-title"
            className="text-[17px] font-semibold leading-snug tracking-[-0.01em] text-mono-900 dark:text-mono-50"
          >
            About these checks
          </h2>
          <p className="text-[13px] leading-snug text-mono-500">{VALIDATION_SUMMARY[status]}</p>
        </div>

        <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-mono-600 dark:text-mono-300">
          <p>{EXPLAINER[status]}</p>
          <p>
            Every coupon is signed by the stall that issued it. Your wallet checks that signature
            on arrival, using only what is on this phone — no network, and nothing to trust but
            the maths.
          </p>
          <p className="text-[13px] text-mono-500">
            A verified signature proves who issued the coupon and that its value has not been
            altered since. It does not prove the stall will honour it.
          </p>
        </div>

        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="pressable min-h-11 w-full rounded-2xl bg-mono-900 text-sm font-medium text-mono-50 outline-none ring-mono-400 focus-visible:ring-2 dark:bg-mono-50 dark:text-mono-900"
        >
          Done
        </button>
      </div>
    </dialog>
  )
}

/**
 * The one paragraph that is about the coupon in front of you.
 *
 * Each says what happened and what to do, in that order. None of them says
 * "valid" on its own — the word promises more than a signature check delivers.
 */
const EXPLAINER: Record<ValidationStatus, string> = {
  verified:
    'This coupon carries a signature from the stall that issued it, and that signature checks out. The issuer and the amount are exactly what they claim to be.',
  unchecked:
    'Nothing was verified for this one. Either it arrived before your wallet started checking signatures, or it is plain ecash, which carries no issuer claim to check. That is not a problem in itself — it just means there is nothing here to confirm.',
  failed:
    'Something does not add up. Either the signature did not check out, or the coupon claimed to be worth more than the stall signed for. Do not treat it as paid — take it up with the stall that issued it.',
}


/**
 * Whether the customer ever redeemed a cashback code, in the merchant's words.
 *
 * The question this whole screen exists to answer for a cashback row: a code
 * was read out across a counter, and nothing about what happened to it
 * afterwards reaches this device. Only the gateway knows, so only the gateway
 * is asked.
 *
 * "Not checked yet" is a real answer and is shown as one. A row whose status
 * could not be fetched must not read as unredeemed — a merchant deciding
 * whether to honour a code twice is exactly who a confident guess would hurt.
 */
/**
 * A Cashlink's send and its take-back, each one tap from the other. A take-back row names the row
 * that made the link (`returnOf`); that row lists what came back from it. Nothing here shows the
 * link key: both ends are row ids.
 */
function CashlinkReturnSection({ tx }: { tx: WalletTransaction }) {
  const [returns, setReturns] = useState<WalletTransaction[]>([])
  const sentLink = tx.link?.k

  useEffect(() => {
    if (!sentLink) {
      setReturns([])
      return
    }
    const load = async () => setReturns(cashlinkReturnsOf((await listTransactions()).map(toTransaction), tx))
    void load()
    return onWalletChanged(load)
    // Only the link and the row decide what is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentLink, tx.id])

  if (tx.returnOf) {
    // #643: a return off a checkout code or an unclaimed gift links to that row, not a Cashlink.
    const what = returnOfLabel(tx.returnOf)
    return (
      <ListSection title={what.title}>
        <Link
          to={what.to}
          className="press-row -mx-1 flex items-center gap-3 rounded-xl p-3"
        >
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-mono-900 dark:text-mono-50">{what.link}</span>
            <span className="block text-sm text-mono-500">This voucher came back from it</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" aria-hidden />
        </Link>
      </ListSection>
    )
  }
  if (returns.length === 0) return null
  return (
    <ListSection title="Came back">
      {returns.map((r) => (
        <Link
          key={r.id}
          to={`/transaction/${encodeURIComponent(r.id)}`}
          className="press-row -mx-1 flex items-center gap-3 rounded-xl p-3"
        >
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-mono-900 dark:text-mono-50">
              +{formatFace(r.amount, { unit: r.unit, decimals: r.decimals })}
            </span>
            <span className="block text-sm text-mono-500">{formatDate(r.at)}</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" aria-hidden />
        </Link>
      ))}
    </ListSection>
  )
}

function CashbackSection({ tx }: { tx: WalletTransaction }) {
  const { reading, checking } = useCashbackStatus({
    rowId: tx.id,
    cashbackId: tx.cashbackId,
    cachedStatus: tx.cashbackStatus,
    cachedClaimedAt: tx.claimedAt,
  })

  const [cancelled, setCancelled] = useState(false)

  if (!tx.cashbackId) return null

  const status = cancelled ? 'Revoked' : reading?.status
  const redeemed = status === 'Claimed'
  const open = status === 'Unclaimed'

  return (
    <ListSection title="Cashlink">
      <DetailRow
        label="Redeemed"
        value={
          <span
            className={
              redeemed
                ? 'text-green-600'
                : status === undefined
                  ? 'text-mono-500'
                  : 'text-mono-900 dark:text-mono-50'
            }
          >
            {/* `?? REDEMPTION.unknown` because the status is whatever string the
                gateway sent — `fetchCashbackStatus` casts it rather than
                validating it. A state this build has never heard of must read
                as "could not check", not as an empty line the merchant reads
                as "not redeemed". */}
            {REDEMPTION[status ?? (checking ? 'checking' : 'unknown')] ?? REDEMPTION.unknown}
          </span>
        }
      />
      {/*
        The date only where there IS one. On an unclaimed code the field would
        be an em-dash saying the same thing the line above already said.
      */}
      {redeemed && reading?.claimedAt ? (
        <DetailRow label="Redeemed on" value={formatDate(reading.claimedAt)} />
      ) : null}
      {/* Kept even when absent, but NOT as "never expires": the gateway applies
          its own term to every cashback whether or not it echoed one back, so
          an unrecorded expiry is an unknown, not an absent one. Telling a
          merchant at a counter that a code lasts forever is the one wrong
          answer here. */}
      <DetailRow label="Expires" value={formatDate(tx.expiresAt) || 'Not recorded'} />
      {/* Only while the gateway says it is still open: a claimed, cancelled or expired code has
          no link worth showing, and an unchecked one is not offered a destructive Cancel. */}
      {open ? (
        <div className="space-y-2 py-3">
          <ShowQrAgain cashbackId={tx.cashbackId} expiresAt={tx.expiresAt} />
          <CancelCashback
            cashbackId={tx.cashbackId}
            onCancelled={() => {
              setCancelled(true)
              void recordCashbackStatus(tx.id, { status: 'Revoked' })
            }}
          />
        </div>
      ) : null}
    </ListSection>
  )
}

/** Why the link could not be rebuilt, in the merchant's words. */
const REBUILD_FAILURE: Record<string, string> = {
  terminal: 'This Cashlink is no longer open, so there is no link to show.',
  not_found: 'The gateway did not find this Cashlink just now. Try again in a minute.',
  throttled: 'Too many tries. Wait a minute and try again.',
}

/**
 * Show QR again (spec 4.1): rebuild the link through the portal's authenticated, owner-scoped
 * `GET /cashback/{id}/link` (wallet#268), which spends nothing. The key comes back in memory only
 * and is dropped with this component: it is never written to the row or anywhere else.
 */
function ShowQrAgain({ cashbackId, expiresAt }: { cashbackId: string; expiresAt?: number }) {
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; link: string } | { kind: 'failed'; message: string }
  >({ kind: 'idle' })

  const rebuild = async () => {
    setState({ kind: 'loading' })
    const result = await fetchCashbackLink(cashbackId)
    const link = result.kind === 'ok' ? formatCashbackLink(window.location.origin, result.ref, result.key) : null
    if (link) {
      setState({ kind: 'ok', link })
      return
    }
    setState({
      kind: 'failed',
      message: REBUILD_FAILURE[result.kind] ?? 'Could not rebuild the link just now. Try again.',
    })
  }

  if (state.kind === 'ok') {
    return <ClaimLinkPanel link={state.link} expiresAt={expiresAt} initiallyShown />
  }
  return (
    <>
      {state.kind === 'failed' && <p className="text-sm text-mono-500">{state.message}</p>}
      <Button
        variant="secondary"
        className="w-full"
        disabled={state.kind === 'loading'}
        onClick={() => void rebuild()}
      >
        {state.kind === 'loading' ? 'Rebuilding the link…' : 'Show QR again'}
      </Button>
    </>
  )
}

/**
 * One line per state, each saying what happened rather than naming the enum.
 *
 * `ManualAttention` is the gateway's word for a cashback whose token could not
 * be parked or reclaimed cleanly. The merchant cannot fix that from here, so
 * the line says what it means for them — the money is neither spent nor safely
 * back — and nothing about the internals.
 */
const REDEMPTION: Record<string, string> = {
  Claimed: 'Yes, redeemed by the customer',
  Unclaimed: 'Not yet — the Cashlink is still open',
  Expired: 'No, and the Cashlink has expired',
  Revoked: 'No, the Cashlink was cancelled',
  ManualAttention: 'Unresolved — ask support about this one',
  checking: 'Checking…',
  unknown: 'Could not check just now',
}

/**
 * `trading` is the same gate App puts on the merchant routes, so it is also the
 * answer to "does /merchant/transactions exist for this user" — routing a
 * customer there would bounce them to the catch-all redirect.
 */
export function TransactionPage({
  pubkey,
  trading = false,
}: {
  pubkey?: string
  trading?: boolean
}) {
  const { id = '' } = useParams()
  const [tx, setTx] = useState<WalletTransaction | null | undefined>(undefined)

  useEffect(() => {
    const load = async () => {
      const found = await getTransactionRow(id)
      setTx(found ? toTransaction(found) : null)
    }
    load()
    // A cashback row saved before #156 carries no validation. Check it now;
    // the write notifies, so `load` picks the result up.
    void recheckCashbackRowOnOpen(id)
    return onWalletChanged(load)
  }, [id])

  if (tx === undefined) return <Centered>Loading…</Centered>
  if (tx === null) return <Centered>This transaction is no longer in your wallet.</Centered>

  const outgoing = tx.direction === 'out'
  // Whose stall this row belongs to. On the merchant's own rows `merchantId` is
  // the merchant, so it names nobody the transaction was WITH.
  const ownStall = tx.merchantId !== undefined && tx.merchantId === pubkey
  const party = otherParty(tx, pubkey)
  // A merchant came from their own transaction list. The merchant page behind
  // `merchantId` is the CUSTOMER's view of a stall they hold coupons from —
  // sending a merchant there lands them on a page about themselves that they
  // never opened.
  const backTo = trading
    ? '/merchant/transactions'
    : tx.merchantId
      ? `/merchants/${tx.merchantId}`
      : '/'

  return (
    <Screen>
      <BackLink to={backTo} label="Back" />

      <Panel className="mb-6 p-5">
        <p className="text-amount text-mono-900 dark:text-mono-50">
          {outgoing ? '−' : '+'}
          {formatFace(tx.amount, { unit: tx.unit, decimals: tx.decimals })}
        </p>
        {/*
          `humanName`, not the raw field. `_buildReceiveTransactionRow` fills
          `merchantName` from the coupon's merchant metadata, which for a stall
          that has published no kind-0 profile is the merchant_id — so this line
          printed 64 hex characters next to the amount on the settlement
          receipt. Everywhere else on this screen goes through IdentityInline,
          which never renders a full key; this was the one place that did.

          Dropping to just the type is right rather than falling back to a
          shortened key: the person is already named in the panel below, and a
          truncated hex string beside the amount tells the reader nothing they
          can act on.
        */}
        <p className="truncate text-sm text-mono-500">
          {transactionLabel(tx)}
          {!ownStall && humanName(tx.merchantName) ? ` · ${humanName(tx.merchantName)}` : ''}
        </p>
      </Panel>

      {/*
        Out of the details drawer and onto the page. Who you dealt with is the
        second thing anyone wants from a receipt, after the amount — and on a
        till it is the ONLY other name in the record.
      */}
      {party ? (
        <Panel className="mb-6 p-5">
          <IdentityInline pubkey={party.pubkey} label={party.label} size="md" />
        </Panel>
      ) : null}

      {/* A coupon of this same payment turned away before the swap (#145). */}
      {!outgoing ? (
        // The row's counterparty is the payer of the coupon that DID land, so
        // a refusal from the same sender is part of this same payment.
        <RefusedCouponsNote
          pubkey={pubkey}
          bundleId={tx.bundleId}
          requestId={tx.paymentId}
          payer={tx.counterparty}
          className="mb-6"
        />
      ) : null}

      <ListSection title="Transaction">
        {present([
          ['Type', transactionLabel(tx)],
          ['Date', formatDate(tx.at)],
          ['Memo', tx.memo],
          // #402 traceability: an online shop said which of its orders spent this coupon. The
          // shop's own word (its key sealed the envelope), shown as such.
          ['Spent online', tx.spendSource ? spendSourceLabel(tx.spendSource) : undefined],
          [
            'Applied to the order',
            tx.spendSource?.amountApplied !== undefined
              ? formatFace(tx.spendSource.amountApplied, { unit: tx.unit, decimals: tx.decimals })
              : undefined,
          ],
          ['Checkout code', tx.spendSource?.codeRef],
          /**
           * Which terminal took this — terminals ticket 09.
           *
           * The stall's OWN records only, which is what this screen is: the
           * row is decrypted from the merchant's own history. A customer
           * reading their copy of the same sale sees no such field, because a
           * coupon should say who honours it and nothing about how the stall
           * is staffed.
           *
           * Shown only on the stall's own rows. On a customer's screen the
           * field is absent anyway, but gating it on `ownStall` means a future
           * row that carried one by mistake still would not display it.
           */
          [
            'Handled by',
            // `terminalPubkey` is only ever set on a terminal's row, so this
            // reads "your device" for every sale the owner took themselves.
            ownStall && tx.type === 'issued'
              ? handlerFor(
                  tx.terminalPubkey ? { terminalPubkey: tx.terminalPubkey } : undefined,
                  pubkey,
                ).label
              : '',
          ],
          // Visible for the same reason as the coupon id: it names the record.
          ['Transaction id', tx.id],
        ]).map(([label, value]) => (
          <DetailRow key={label} label={label} value={value} />
        ))}
      </ListSection>

      <CashbackSection tx={tx} />

      {/* Spec 049: the proof of this payment, beside the payment it proves. Outgoing only: the
          payer holds the receipt; the stall checks it by scanning. */}
      {outgoing ? <ReceiptSection txId={tx.id} /> : null}

      {/* #402 traceability: an incoming coupon of the stall's own, linked to the sale that issued
          it. The voucher id is the same from sale to spend, so the voucher's own record (what was
          paid, by which rail, what is still out) is one tap away. */}
      {ownStall && !outgoing && tx.voucherId ? (
        <ListSection title="Voucher">
          <Link
            to={`/merchant/coupon/${encodeURIComponent(tx.voucherId)}`}
            className="press-row -mx-1 flex items-center gap-3 rounded-xl p-3"
          >
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-mono-900 dark:text-mono-50">See the sale of this voucher</span>
              <span className="block text-sm text-mono-500">Who bought it, how it was paid, what is still out</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" aria-hidden />
          </Link>
        </ListSection>
      ) : null}

      <GiftLinkSection link={tx.link} />

      <CashlinkReturnSection tx={tx} />

      <ValidationSection tx={tx} />

      <RawDetails
        entries={present<React.ReactNode>([
          ['Raw type', tx.type],
          // Both of these are people, and the drawer is where someone looks to
          // see WHO — the hex key answered a question nobody asked.
          // Both dropped once they are the person already named above — the
          // drawer is for what the summary left out, and on a till the merchant
          // is the person reading the screen.
          ['Merchant', tx.merchantId && !ownStall ? <IdentityInline pubkey={tx.merchantId} /> : undefined],
          [
            'Counterparty',
            tx.counterparty && tx.counterparty !== party?.pubkey ? (
              <IdentityInline pubkey={tx.counterparty} />
            ) : undefined,
          ],
          ['Voucher id', tx.tokenId],
          ['Issuance id', tx.voucherId],
          ['Cashback id', tx.cashbackId],
          ['Bundle id', tx.bundleId],
          // Where the machine strings live, beside the other ids. These are
          // what an auditor looks the record up BY: the nullifier is the `#n`
          // tag a filter matches, the event id addresses the event directly.
          //
          // Both gated on the event id, not on the nullifier: a nullifier with
          // no published record identifies nothing an auditor could fetch, and
          // showing it under a heading about the ledger would imply otherwise.
          //
          // The COMMITMENT is deliberately not here. A reader holding this row
          // already knows the amount and could recompute it, and printing it
          // beside the amount invites treating a public value as a private one.
          ['Ledger record id', tx.attestationEventId],
          [
            'Ledger reference',
            hasPublishedAttestation(tx) ? tx.attestationNullifier : undefined,
          ],
        ])}
      />
    </Screen>
  )
}
