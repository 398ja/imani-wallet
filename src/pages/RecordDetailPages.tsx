import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
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
} from '../components/ui'
import { getVoucherRow, getTransactionRow, onWalletChanged } from '../lib/wallet'
import { issuanceRatioOf } from '../lib/farmers'
import { formatFace, formatDate, formatSats } from '../lib/format'
import { toCouponPass, TERMS, EMPTY_BRANDING, type MerchantBranding } from '../lib/pass'
import { merchantBranding } from '../lib/branding'
import { toTransaction, transactionLabel, type WalletTransaction } from '../lib/transactions'

/**
 * The way from a movement to the coupon it moved, when there is one.
 *
 * Two different destinations, because a merchant's issued coupon is not in this
 * wallet — it was given away, so there is no voucher row and `/coupon/:tokenId`
 * would find nothing. Its detail is rebuilt from the issuance record instead.
 *
 * Rendered as the section's `action`, the same slot `SeeAll` uses elsewhere.
 */
function couponLink(tx: WalletTransaction) {
  const to =
    tx.type === 'issued' && tx.voucherId
      ? `/merchant/coupon/${encodeURIComponent(tx.voucherId)}`
      : tx.tokenId
        ? `/coupon/${encodeURIComponent(tx.tokenId)}`
        : null

  if (!to) return undefined
  return (
    <Link to={to} className="text-sm text-mono-500 hover:text-mono-900 dark:hover:text-mono-50">
      View coupon
    </Link>
  )
}

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
function present(entries: Array<[string, string | undefined | null]>): Array<[string, string]> {
  return entries.filter((e): e is [string, string] => Boolean(e[1]))
}

export function CouponPage() {
  const { tokenId = '' } = useParams()
  const [row, setRow] = useState<VoucherRow | null | undefined>(undefined)
  const [branding, setBranding] = useState<MerchantBranding>(EMPTY_BRANDING)

  useEffect(() => {
    const load = async () => {
      const found = await getVoucherRow(tokenId)
      setRow(found)
      // The pass renders the farmer's name from branding, so there is no
      // findFarmer lookup here. There used to be, and it survived the pass
      // rewrite as a full listVouchers() + toFarmers() pass over every coupon in
      // the wallet — on mount and again on every wallet write — feeding a state
      // value no JSX read.
      if (found?.issuer_id) {
        // Never rejects; an unbranded farmer falls back to the pass defaults.
        merchantBranding(found.issuer_id).then(setBranding)
      }
    }
    load()
    // A coupon can be spent from another screen while this one is open.
    return onWalletChanged(load)
  }, [tokenId])

  if (row === undefined) return <Centered>Loading…</Centered>
  if (row === null) return <Centered>This coupon is no longer in your wallet.</Centered>

  const backTo = row.issuer_id ? `/farmer/${row.issuer_id}` : '/'

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

      <ListSection title="Coupon">
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
          ['Coupon id', row.token_id],
        ]).map(([label, value]) => (
          <DetailRow key={label} label={label} value={value} />
        ))}
      </ListSection>

      <RawDetails
        entries={present([
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
          ['Voucher id', row.voucher_id],
          ['Farmer', row.issuer_id],
          ['Face decimals', row.face_decimals === undefined ? undefined : String(row.face_decimals)],
          ['Updated', formatDate(row.updated_at)],
          ['Source', row.source_transport],
          ['Received via', row.received_via_event_id],
          // The pass's back fields are voucherId / issuer / terms. The first two
          // are already above as "Voucher id" and "Farmer", so only the terms
          // are new — repeating the other two to mirror the record's grouping
          // would show the same value twice in one block.
          ['Terms', TERMS],
        ])}
      />
    </Screen>
  )
}

export function TransactionPage() {
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
  const backTo = tx.merchantId ? `/farmer/${tx.merchantId}` : '/'

  return (
    <Screen>
      <BackLink to={backTo} label="Back" />

      <Panel className="mb-6 p-5">
        <p className="text-balance text-mono-900 dark:text-mono-50">
          {outgoing ? '−' : '+'}
          {formatFace(tx.amount, { unit: tx.unit, decimals: tx.decimals })}
        </p>
        <p className="truncate text-sm text-mono-500">
          {transactionLabel(tx)}
          {tx.merchantName ? ` · ${tx.merchantName}` : ''}
        </p>
      </Panel>

      <ListSection title="Transaction" action={couponLink(tx)}>
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

      <RawDetails
        entries={present([
          ['Raw type', tx.type],
          ['Farmer', tx.merchantId],
          ['Counterparty', tx.counterparty],
          ['Coupon id', tx.tokenId],
          ['Voucher id', tx.voucherId],
          ['Bundle id', tx.bundleId],
        ])}
      />
    </Screen>
  )
}
