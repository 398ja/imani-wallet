import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'

import type { PassField, PassJson } from '../../lib/pass'
import { formatDate, formatFace, shortPubkey } from '../../lib/format'
import { Avatar } from './Avatar'

/**
 * A coupon, or a merchant's whole holding, rendered as a wallet pass.
 *
 * The layout is not invented here — it is `PassJson`'s, from cashu-voucher's
 * `cashu-voucher-pass` module: a banner strip, an organisation with a logo, one
 * primary field carrying the balance, an auxiliary expiry, and a barcode. See
 * `src/lib/pass.ts` for why the record is built client-side.
 *
 * Colours arrive as `rgb(r,g,b)` strings on the pass and are applied inline,
 * because they are *data* about a merchant, not app theme. Everything else stays
 * on the app's `mono` palette and `rounded-2xl` border treatment so the card sits
 * inside the existing visual language rather than beside it.
 */

interface PassProps {
  pass: PassJson
  /** When set, the whole card becomes a link here. */
  to?: string
}

/** A raw 64-char hex pubkey standing in for a name would overflow the card. */
function displayName(name: string): string {
  return /^[0-9a-f]{64}$/i.test(name) ? shortPubkey(name) : name
}

function fieldValue(field: PassField): string {
  if (field.dateStyle) return formatDate(String(field.value))
  if (typeof field.value === 'number') {
    return formatFace(field.value, { unit: field.unit ?? '', decimals: field.decimals ?? 0 })
  }
  return String(field.value)
}

function PassBarcode({ format, message, altText }: { format: string; message: string; altText: string }) {
  const [dataUrl, setDataUrl] = useState<string>()

  useEffect(() => {
    let live = true
    QRCode.toDataURL(message, { width: 512, margin: 1 }).then(
      (url) => {
        if (live) setDataUrl(url)
      },
      // A pass without its code is still a useful card, so a failure here is
      // silent rather than an error state over the balance.
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [message])

  if (!format.includes('QR') || !dataUrl) return null

  return (
    <div className="flex flex-col items-center gap-2 rounded-xl bg-white p-3">
      <img src={dataUrl} alt={`Redemption code ${altText}`} className="w-40" />
      {/* For a cashier to key in when the scanner fails — the bare id, no prefix. */}
      <p className="break-all text-center font-mono text-[0.625rem] text-mono-500">{altText}</p>
    </div>
  )
}

export function Pass({ pass, to }: PassProps) {
  const balance = pass.storeCard.primaryFields?.[0]
  const expiry = pass.storeCard.auxiliaryFields?.[0]
  const code = pass.barcodes?.[0]
  const logoUrl = pass.userInfo.logoUrl
  const stripUrl = pass.userInfo.stripUrl
  const issuer = pass.userInfo.issuer
  const nip05 = pass.userInfo.issuerNip05

  const card = (
    <div
      className="overflow-hidden rounded-2xl border border-mono-200 dark:border-mono-800"
      style={{ backgroundColor: pass.backgroundColor, color: pass.foregroundColor }}
    >
      {stripUrl && (
        // Issuer-supplied URL — see branding.ts. `no-referrer` keeps the coupon
        // route out of the request to their host, and `lazy` avoids fetching a
        // card that is scrolled off the deck.
        <img
          src={stripUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-24 w-full object-cover"
        />
      )}

      <div className="p-5">
        <div className="flex items-center gap-3">
          <Avatar
            src={logoUrl}
            name={displayName(pass.organizationName)}
            pubkey={issuer}
            size="md"
          />
          <div className="min-w-0">
            <p className="truncate font-semibold">{displayName(pass.organizationName)}</p>
            <p className="truncate text-xs" style={{ color: pass.labelColor, opacity: 0.7 }}>
              {pass.description}
            </p>
            {/*
              WHO, under the name. kind-0 is self-published and unverified: a
              second pubkey can publish the same name and picture, and coupons
              are per-issuer, so a customer paying the wrong "Rosa Green Farm" is
              a real outcome — the card has to say which one this is.

              Their NIP-05 handle when they have one, because a short pubkey is
              unreadable and nobody compares one. The handle is weaker evidence
              (also self-published, and not checked against its domain here), but
              a name a person can actually read is a disambiguator they will use.
              Falls back to the short pubkey, which is still the unforgeable one.
              Skipped when the name IS the pubkey — unbranded, it is on screen
              already.
            */}
            {issuer && issuer !== pass.organizationName && (
              <p
                className={`truncate text-[0.625rem] ${nip05 ? '' : 'font-mono'}`}
                style={{ color: pass.labelColor, opacity: 0.55 }}
              >
                {nip05 ?? shortPubkey(issuer)}
              </p>
            )}
          </div>
        </div>

        {balance && (
          <div className="mt-5">
            <p
              className="text-xs font-medium tracking-wide"
              style={{ color: pass.labelColor, opacity: 0.7 }}
            >
              {balance.label}
            </p>
            <p className="text-amount">{fieldValue(balance)}</p>
          </div>
        )}

        {expiry && (
          <div className="mt-3">
            <p
              className="text-xs font-medium tracking-wide"
              style={{ color: pass.labelColor, opacity: 0.7 }}
            >
              {expiry.label}
            </p>
            <p className="text-sm">{fieldValue(expiry)}</p>
          </div>
        )}

        {pass.voided && (
          <p className="mt-4 inline-block rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700">
            This voucher has been used
          </p>
        )}

        {code && (
          <div className="mt-5 flex justify-center">
            <PassBarcode format={code.format} message={code.message} altText={code.altText} />
          </div>
        )}
      </div>
    </div>
  )

  // `voided` dims the card, but only when it is not a link — a dimmed control
  // reads as disabled, and a merchant's card is always tappable.
  if (!to) return <div className={pass.voided ? 'opacity-60' : undefined}>{card}</div>

  // Feedback on the press, not on the release. Waiting for the tap to complete
  // before acknowledging it is where directness falls off a cliff: the card is
  // the way into a merchant, and until it moves the user cannot tell a slow
  // navigation from a missed tap. `active:` fires on pointer-down.
  return (
    <Link
      to={to}
      className="block transition duration-100 ease-out hover:opacity-90 active:scale-[0.98] active:opacity-90 motion-reduce:transition-opacity motion-reduce:active:scale-100"
    >
      {card}
    </Link>
  )
}
