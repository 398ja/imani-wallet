import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
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
} from '../components/ui'
import { getVoucherRow, getTransactionRow, onWalletChanged } from '../lib/wallet'
import { issuanceRatioOf } from '../lib/merchants'
import { formatFace, formatDate, formatSats } from '../lib/format'
import { toCouponPass, TERMS, EMPTY_BRANDING, type MerchantBranding } from '../lib/pass'
import { merchantBranding } from '../lib/branding'
import { toTransaction, transactionLabel, type WalletTransaction } from '../lib/transactions'

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
  // Only meaningful for coupons arriving here. An outgoing row is this wallet's
  // own act, and plain ecash carries no issuer claim to check.
  if (tx.direction !== 'in' || !tx.voucherId) return null

  const v = tx.validation
  if (!v) {
    return (
      <ListSection title="Checks">
        <DetailRow label="Issuer" value="Not checked" />
      </ListSection>
    )
  }

  return (
    <ListSection title="Checks">
      <DetailRow
        label="Issuer"
        value={v.signatureValid ? 'Signature verified' : 'Signature did not verify'}
      />
      {v.cappedAtFaceValue ? (
        <DetailRow
          label="Value"
          value={`Limited to the ${formatFace(v.signedFaceValue, {
            unit: tx.unit,
            decimals: tx.decimals,
          })} originally issued`}
        />
      ) : null}
    </ListSection>
  )
}

/**
 * `trading` is the same gate App puts on the merchant routes, so it is also the
 * answer to "does /merchant/transactions exist for this user" — routing a
 * customer there would bounce them to the catch-all redirect.
 */
export function TransactionPage({ trading = false }: { trading?: boolean }) {
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
        <p className="truncate text-sm text-mono-500">
          {transactionLabel(tx)}
          {tx.merchantName ? ` · ${tx.merchantName}` : ''}
        </p>
      </Panel>

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
          ['Merchant', tx.merchantId ? <IdentityInline pubkey={tx.merchantId} /> : undefined],
          ['Counterparty', tx.counterparty ? <IdentityInline pubkey={tx.counterparty} /> : undefined],
          ['Voucher id', tx.tokenId],
          ['Issuance id', tx.voucherId],
          ['Bundle id', tx.bundleId],
        ])}
      />
    </Screen>
  )
}
