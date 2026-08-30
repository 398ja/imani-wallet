import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Info } from 'lucide-react'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  Screen,
  BackLink,
  Panel,
  ListSection,
  DetailRow,
  RawDetails,
  Centered,
  Pass,
  IdentityInline,
  ValidationBadge,
} from '../components/ui'
import { getVoucherRow, getTransactionRow, onWalletChanged } from '../lib/wallet'
import { issuanceRatioOf } from '../lib/merchants'
import { formatFace, formatDate, formatSats } from '../lib/format'
import { toCouponPass, TERMS, EMPTY_BRANDING, type MerchantBranding } from '../lib/pass'
import { merchantBranding } from '../lib/branding'
import { humanName } from '../lib/identity'
import {
  VALIDATION_SUMMARY,
  hasValidationClaim,
  validationStatus,
  type ValidationStatus,
} from '../lib/validationStatus'
import { otherParty, toTransaction, transactionLabel, type WalletTransaction } from '../lib/transactions'

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
 * The issuance ratio, spelled out rather than left as a bare float.
 *
 * `issuance_ratio` is face MINOR UNITS PER SAT, and "1" alone tells a reader
 * nothing about which way round that is. It is also the number a future split
 * turns on — the smallest face amount a coupon can be divided into is
 * ceil(ratio), because a cashu proof is indivisible below one sat.
 */
function ratioLabel(row: VoucherRow): string | undefined {
  // Via issuanceRatioOf, not row.issuance_ratio: coupons received before the
  // field was persisted store an explicit null, and the ratio is derivable from
  // face/sats anyway. Reading the row directly would show the ratio on new
  // coupons and omit it on old ones for no reason a user could see.
  const ratio = issuanceRatioOf(row)
  if (ratio === undefined) return undefined
  const unit = row.face_unit ?? 'face'
  return `${Number(ratio.toFixed(6))} per sat (${unit} minor units)`
}

/** Drop empty entries so the details block only ever shows real data. */
function present<T>(entries: Array<[string, T | undefined | null]>): Array<[string, T]> {
  return entries.filter((e): e is [string, T] => Boolean(e[1]))
}

export function CouponPage() {
  const { tokenId = '' } = useParams()
  const [row, setRow] = useState<VoucherRow | null | undefined>(undefined)
  const [branding, setBranding] = useState<MerchantBranding>(EMPTY_BRANDING)

  useEffect(() => {
    const load = async () => {
      const found = await getVoucherRow(tokenId)
      setRow(found)
      // The pass renders the merchant's name from branding, so there is no
      // findMerchant lookup here. There used to be, and it survived the pass
      // rewrite as a full listVouchers() + toMerchants() pass over every coupon in
      // the wallet — on mount and again on every wallet write — feeding a state
      // value no JSX read.
      if (found?.issuer_id) {
        // Never rejects; an unbranded merchant falls back to the pass defaults.
        merchantBranding(found.issuer_id).then(setBranding)
      }
    }
    load()
    // A coupon can be spent from another screen while this one is open.
    return onWalletChanged(load)
  }, [tokenId])

  if (row === undefined) return <Centered>Loading…</Centered>
  if (row === null) return <Centered>This voucher is no longer in your wallet.</Centered>

  const backTo = row.issuer_id ? `/merchants/${row.issuer_id}` : '/'

  return (
    <Screen>
      <BackLink to={backTo} label="Back" />

      {/*
        The pass replaces what used to be a bare amount-and-name panel. It leads
        with this coupon's own balance and carries the redemption QR — the code a
        merchant scans to redeem against the ledger, NOT the share QR, which
        would hand over the token's bearer value.
      */}
      <div className="mb-6">
        <Pass pass={toCouponPass(row, branding)} />
      </div>

      <ListSection title="Voucher">
        {present([
          ['Status', row.status ?? 'active'],
          ['Received', formatDate(row.created_at)],
          // Exempt from the drop-empty rule the rest of this list follows:
          // "expires 3 Sep" and "never expires" are different facts, and an
          // absent row reads as the second while meaning the first is unknown.
          // Whether a coupon runs out is the thing a holder needs to know.
          ['Expires', formatDate(row.expires_at) || 'No expiry'],
          // The id identifies the record, so it stays visible rather than
          // collapsing into Details with the derived and diagnostic fields.
          ['Voucher id', row.token_id],
        ]).map(([label, value]) => (
          <DetailRow key={label} label={label} value={value} />
        ))}
      </ListSection>

      <RawDetails
        entries={present<React.ReactNode>([
          // The backing trio, kept together: how many sats, under which
          // strategy, at what ratio. `token_amount` is the authoritative sats
          // field — imani-apps reads it at every display site and never decodes
          // proofs at render time. Shown unconditionally, unlike the vanilla
          // hero, which hides behind a Bitcoin flag read from /api/v1/config —
          // an endpoint that 404s here, so the gate would hide it on every
          // coupon. Strategy keeps imani-apps' label and raw enum value.
          ['Backing', row.token_amount ? `${formatSats(row.token_amount)} sats` : undefined],
          ['Backing strategy', row.backing_strategy],
          ['Issuance ratio', ratioLabel(row)],
          // The issuer's own record id, NOT the token id shown above — same
          // screen, two different ids, and one name for both said nothing.
          ['Issuance id', row.voucher_id],
          ['Merchant', row.issuer_id ? <IdentityInline pubkey={row.issuer_id} /> : undefined],
          ['Face decimals', row.face_decimals === undefined ? undefined : String(row.face_decimals)],
          ['Updated', formatDate(row.updated_at)],
          ['Source', row.source_transport],
          ['Received via', row.received_via_event_id],
          // The pass's back fields are voucherId / issuer / terms. The first two
          // are already above as "Voucher id" and "Merchant", so only the terms
          // are new — repeating the other two to mirror the record's grouping
          // would show the same value twice in one block.
          ['Terms', TERMS],
        ])}
      />
    </Screen>
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
        {tx.attestationEventId ? (
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

      <ListSection title="Transaction">
        {present([
          ['Type', transactionLabel(tx)],
          ['Date', formatDate(tx.at)],
          ['Memo', tx.memo],
          // Visible for the same reason as the coupon id: it names the record.
          ['Transaction id', tx.id],
        ]).map(([label, value]) => (
          <DetailRow key={label} label={label} value={value} />
        ))}
      </ListSection>

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
          ['Ledger reference', tx.attestationEventId ? tx.attestationNullifier : undefined],
        ])}
      />
    </Screen>
  )
}
