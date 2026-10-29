import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'

import type { PassField, PassJson } from '../../lib/pass'
import { formatDate, formatFace, handleLabel, UNKNOWN_STALL } from '../../lib/format'
import { printShadow } from '../../lib/printShadow'
import { Avatar } from './Avatar'
import { RemoteImage } from './RemoteImage'
import { SkeletonLine } from './Skeleton'

/**
 * A coupon, or a merchant's whole holding, rendered as a wallet pass.
 *
 * The fields are `PassJson`'s, from cashu-voucher's `cashu-voucher-pass` module:
 * an organisation with a logo, one primary field carrying the balance, an
 * auxiliary expiry, and a barcode. See `src/lib/pass.ts` for why the record is
 * built client-side.
 *
 * The stall's BANNER FILLS THE CARD (#419). It used to be cropped to a 96px
 * strip above a flat black block, so most of it was lost and the card read as a
 * black slab. Now it is drawn full-bleed behind everything; the avatar stays the
 * 40px circle beside the name. Every printed character carries a shadow
 * (`printShadow`), because the banner can be anything, a white background under
 * white text included.
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
  /**
   * When set, the avatar-and-name block links here. For the stall behind a
   * coupon.
   *
   * Separate from `to` rather than reusing it, because on a coupon's own page
   * the card is NOT a link: it carries the redemption QR, and wrapping that in
   * a navigation is how a cashier's tap on the code becomes a page change
   * mid-scan. The identity block is the only part that should move.
   *
   * The two are mutually exclusive in practice — a card that is entirely a link
   * must not contain a second one, which is invalid HTML and gives the inner
   * link unpredictable behaviour. Asserted below rather than left to whoever
   * passes both.
   */
  issuerTo?: string
  /**
   * The issuer's kind-0 has not arrived yet.
   *
   * Only the IDENTITY block waits on it. The balance, the expiry and the
   * barcode come from the coupon in hand and are already correct — blanking the
   * card while a name loads would hide the number the customer opened it for,
   * and make a local fact hostage to a network one.
   *
   * Ignored once the pass carries a real `organizationName`: a caller whose
   * fetch is still running but whose coupon already names its issuer has
   * nothing to wait for.
   */
  loadingIssuer?: boolean
}

/**
 * A raw 64-char hex pubkey standing in for a name. It used to be shortened,
 * which is still a key on screen (#324); the stall's own words replace it as
 * soon as its profile loads, and until then the card says so plainly.
 */
function displayName(name: string): string {
  return /^[0-9a-f]{64}$/i.test(name) ? UNKNOWN_STALL : name
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
    // Its own white panel, so no print shadow: a halo round dark-on-white is a smudge.
    <div className="flex flex-col items-center gap-2 rounded-xl bg-white p-3" style={{ textShadow: 'none' }}>
      <img src={dataUrl} alt={`Redemption code ${altText}`} className="w-40" />
      {/* For a cashier to key in when the scanner fails — the bare id, no prefix. */}
      <p className="break-all text-center font-mono text-[0.625rem] text-mono-500">{altText}</p>
    </div>
  )
}

/**
 * The stall's name and picture, optionally as a link to them.
 *
 * One component for both cases so the LAYOUT cannot drift: the flex row lives
 * here once, rather than being written twice and slowly diverging between the
 * linked and unlinked cards. The padding trick keeps them pixel-identical —
 * `-m-1 p-1` grows the tap target by 4px on every side without moving anything
 * on screen, because a 40px avatar is a small thing to hit on a phone and the
 * name beside it is part of the same idea.
 */
function IssuerBlock({ to, children }: { to?: string; children: ReactNode }) {
  if (!to) return <div className="flex items-center gap-3">{children}</div>

  return (
    <Link
      to={to}
      className="pressable -m-1 flex items-center gap-3 rounded-xl p-1 hover:opacity-90"
    >
      {children}
    </Link>
  )
}

export function Pass({ pass, to, issuerTo, loadingIssuer }: PassProps) {
  const balance = pass.storeCard.primaryFields?.[0]
  const expiry = pass.storeCard.auxiliaryFields?.[0]
  const code = pass.barcodes?.[0]
  const logoUrl = pass.userInfo.logoUrl
  const bannerUrl = pass.userInfo.stripUrl
  const issuer = pass.userInfo.issuer
  const nip05 = pass.userInfo.issuerNip05

  // A link inside a link is invalid HTML, and browsers resolve it by guessing.
  // `to` wins because it is the older contract and the whole card moving is the
  // stronger promise; the inner one is dropped rather than nested.
  const linkIssuer = issuerTo !== undefined && to === undefined

  /*
    Waiting only counts when there is nothing to show. `organizationName` falls
    back to the issuer id, and `displayName` truncates that to a hex fragment —
    so "the name IS the key" is precisely the case where a placeholder is an
    improvement, and any other case is a real name that must not be hidden
    behind one.
  */
  const nameIsKey = /^[0-9a-f]{64}$/i.test(pass.organizationName)
  const waiting = Boolean(loadingIssuer) && nameIsKey
  // The same rule as the avatar: no picture from a profile that has not arrived.
  const picture = waiting ? undefined : bannerUrl
  // The line under the name. Optional: a merchant card has none (#419), the
  // stall's `about` blurb does not belong on a voucher.
  const description = pass.description?.trim() ? pass.description : undefined

  const card = (
    <div
      className="relative isolate overflow-hidden rounded-2xl border border-mono-200 dark:border-mono-800"
      style={{
        // Still painted under the picture: it is the whole card when there is
        // no picture or the link is dead, exactly as before.
        backgroundColor: pass.backgroundColor,
        color: pass.foregroundColor,
        // Set once here and inherited, so every character on the card has it,
        // including any field added later.
        textShadow: printShadow(pass.foregroundColor),
      }}
    >
      {picture && (
        // Issuer-supplied URL, see branding.ts. `RemoteImage` carries the
        // no-referrer and lazy rules and the placeholder, and falls back to the
        // plain background colour when the link is dead.
        //
        // Positioned by a wrapper, not by RemoteImage's own class: it sets
        // `relative`, and `cn` is clsx without tailwind-merge, so an `absolute`
        // passed alongside would lose to it in Tailwind's stylesheet order.
        <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
          <RemoteImage src={picture} className="h-full w-full" />
        </div>
      )}

      <div className="relative p-5">
        {/*
          The stall's name and picture are the way back to the stall. Holding a
          coupon and being unable to reach who issued it is the gap this closes:
          the back arrow went there, but only from a screen the customer had
          arrived from — reaching a coupon any other way left the stall
          unreachable, with its avatar sitting right there looking tappable.

          The whole block, not just the avatar. A 40px circle is a small target
          on a phone, and the name beside it is part of the same idea.
        */}
        <IssuerBlock to={linkIssuer ? issuerTo : undefined}>
          <Avatar
            src={waiting ? undefined : logoUrl}
            name={displayName(pass.organizationName)}
            pubkey={issuer}
            loading={waiting}
            framed
            size="md"
          />
          <div className="min-w-0 flex-1" aria-busy={waiting || undefined}>
            {waiting ? (
              /* Name and handle, at the heights of the lines they replace, so
                 the card does not resize under the balance when they land. The
                 description between them is the coupon's own and needs no wait. */
              <>
                {/* The name's line, at the card's own weight and size. */}
                <SkeletonLine text="text-base font-semibold" width="w-36" />
                {description && (
                  <p className="truncate text-xs" style={{ color: pass.labelColor, opacity: 0.7 }}>
                    {description}
                  </p>
                )}
                {/* Unlike IdentityInline, a second bar here is honest: every
                    stall has a profile, so on a card with an issuer the handle
                    line is about to render. */}
                <SkeletonLine text="text-[0.625rem]" width="w-24" />
              </>
            ) : (
              <>
            <p className="truncate font-semibold">{displayName(pass.organizationName)}</p>
            {description && (
              <p className="truncate text-xs" style={{ color: pass.labelColor, opacity: 0.7 }}>
                {description}
              </p>
            )}
            {/*
              WHO, under the name. kind-0 is self-published and unverified: a
              second pubkey can publish the same name and picture, and coupons
              are per-issuer, so a customer paying the wrong "Rosa Green Farm" is
              a real outcome — the card has to say which one this is.

              Their handle, because a name a person can actually read is a
              disambiguator they will use. It is weaker evidence than the key
              (also self-published, and not checked against its domain here),
              but the key is not shown at all any more (#324): every stall has a
              profile, so a missing handle is a profile still loading, and the
              line simply waits for it rather than printing a key fragment.
            */}
            {issuer && nip05 && issuer !== pass.organizationName && (
              <p
                className="truncate text-[0.625rem]"
                style={{ color: pass.labelColor, opacity: 0.55 }}
              >
                {handleLabel(nip05)}
              </p>
            )}
              </>
            )}
          </div>
        </IssuerBlock>

        {balance && (
          // The amount alone (#419): the big figure on a voucher is plainly
          // what it is worth, so the "Balance" label is not printed. It stays on
          // the pass record, which mirrors the Java mapper.
          <div className="mt-5">
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
          <p
            className="mt-4 inline-block rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700"
            style={{ textShadow: 'none' }}
          >
            This voucher has been used
          </p>
        )}

        {!pass.voided && pass.expired && (
          <p
            className="mt-4 inline-block rounded-full bg-mono-100 px-3 py-1 text-xs font-medium text-mono-700"
            style={{ textShadow: 'none' }}
          >
            This voucher has expired
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
  if (!to) return <div className={pass.voided || pass.expired ? 'opacity-60' : undefined}>{card}</div>

  // Feedback on the press, not on the release. Waiting for the tap to complete
  // before acknowledging it is where directness falls off a cliff: the card is
  // the way into a merchant, and until it moves the user cannot tell a slow
  // navigation from a missed tap. `active:` fires on pointer-down.
  return (
    <Link
      to={to}
      className="pressable block hover:opacity-90"
    >
      {card}
    </Link>
  )
}
