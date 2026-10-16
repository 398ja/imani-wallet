import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Banknote, Check, Copy, Info, QrCode, Tag } from 'lucide-react'
import QRCode from 'qrcode'
import { nip19 } from 'nostr-tools'

import { Avatar, BackLink, Centered, RemoteImage, Screen } from '../components/ui'
import { LocationMap } from '../components/LocationMap'
import { MerchantActions } from '../components/MerchantActions'
import { merchantBranding } from '../lib/branding'
import { handleLabel, shortPubkey } from '../lib/format'
import { toRecipientPubkey } from '../lib/issue'
import { fetchMerchantRecord, merchantStatus, type MerchantProfile, type MerchantStatus } from '../lib/merchant'
import type { MerchantBranding } from '../lib/pass'

/**
 * Somebody else's profile, read-only.
 *
 * ## Why this is not `/merchants/:pubkey`
 *
 * That page exists and looks similar, and it is a different thing: it is MY
 * RELATIONSHIP with a stall — the coupons I hold from them, the transactions I
 * have had with them, a Send button for spending what I have. It is a page in
 * my wallet that happens to be about them. Tapping someone's face and landing
 * on my own holdings is an answer to a question nobody asked.
 *
 * This is the page their avatar should open: who they are, what they sell, and
 * how to buy from them. It renders identically for a stranger and for a
 * customer holding twenty of their coupons, because none of that is about them.
 *
 * ## Everything here is public, and that is the whole design
 *
 * kind-0 for the person (name, picture, banner, about) and kind-30078 for the
 * stall (description, location, categories, currency, whether they take cards).
 * Both are self-published to a relay and readable by anyone, so this page needs
 * no session, no relationship and no gateway leg. A shopper who scanned a QR at
 * a market stall can open it.
 *
 * Nothing is editable and nothing is fetched about the VIEWER, which is what
 * makes "read-only" a structural property rather than a promise. There is no
 * code path here that could write.
 *
 * ## MERCHANTS ONLY
 *
 * A customer's key gets "no public profile", not an empty version of this page.
 * Two reasons, and the second is the one that matters:
 *
 * 1. There is nothing to show. A customer publishes no stall record, so every
 *    field below would be blank and the page would read as a broken merchant
 *    rather than an ordinary person.
 * 2. A customer has not asked to be looked up. A stall record is a shop sign —
 *    published so strangers can find it — while an ordinary person's kind-0 is
 *    not an invitation to a profile page inside someone else's wallet. Refusing
 *    here means the app cannot become a directory of its own users by accident.
 *
 * The refusal is enforced HERE rather than only at the link, because a URL can
 * be typed, shared or deep-linked. `IdentityInline` already declines to link a
 * customer; this makes that a property of the page rather than of one caller.
 */
export function PublicProfilePage({ viewerPubkey }: { viewerPubkey?: string }) {
  /*
    The URL may carry a hex key, an npub, a full `name@domain`, or just the
    local part — `/profile/cocoa` is the form a person can say out loud, and the
    one that ends up in a message or on a card.

    Resolved through `toRecipientPubkey`, which the scanner and the paste box
    already use, so a handle typed here behaves exactly as one typed there:
    same completion of a bare local part against the gateway's own domain, same
    tolerance of a leading `@`, same null rather than a throw.

    `resolved` is undefined while the lookup runs and null when it fails, which
    the render below tells apart — a handle that resolves to nobody must say so
    rather than render an empty profile for a name that does not exist.
  */
  const { pubkey: param = '' } = useParams()
  const [resolved, setResolved] = useState<string | null>()
  const [copied, setCopied] = useState(false)
  const [showCode, setShowCode] = useState(false)

  /*
    Hex is by far the common case — every link this app generates uses it — so
    it is DERIVED rather than fetched. Setting it from an effect would be a
    cascading render for a value the URL already contains, which is the pattern
    react-hooks/set-state-in-effect exists to stop.
  */
  const direct = /^[0-9a-f]{64}$/i.test(param) ? param.toLowerCase() : null

  useEffect(() => {
    if (direct) return
    let cancelled = false
    void toRecipientPubkey(param).then((hex) => {
      if (!cancelled) setResolved(hex)
    })
    return () => {
      cancelled = true
    }
  }, [param, direct])

  const lookedUp = direct ?? resolved
  const pubkey = lookedUp ?? ''
  const [branding, setBranding] = useState<MerchantBranding>()
  const [record, setRecord] = useState<MerchantProfile | null>()
  const [status, setStatus] = useState<MerchantStatus>()

  useEffect(() => {
    if (!pubkey) return
    let cancelled = false
    // Never rejects: an unbranded or unreachable profile resolves to empty
    // fields rather than throwing, so the page always renders something.
    void merchantBranding(pubkey).then((b) => {
      if (!cancelled) setBranding(b)
    })
    return () => {
      cancelled = true
    }
  }, [pubkey])

  useEffect(() => {
    if (!pubkey) return
    let cancelled = false
    /*
      Is this a stall at all? The THREE-WAY answer matters: `merchantStatus`
      distinguishes "customer" from "unknown" (relay unreachable), and only the
      first is a refusal. Treating an outage as "not a merchant" would tell a
      shopper a real stall does not exist, which is a lie the app cannot take
      back — they would go elsewhere.

      `isMerchantPubkey`, used for the avatar badge, collapses unknown to false
      on purpose: a missing badge costs nothing. A missing PAGE costs a sale, so
      this one reads the status directly.
    */
    void merchantStatus(pubkey).then((s) => {
      if (!cancelled) setStatus(s)
    })
    return () => {
      cancelled = true
    }
  }, [pubkey])

  useEffect(() => {
    if (!pubkey) return
    let cancelled = false
    /*
      The stall record, with a deadline. Same shape as MerchantPage: a relay
      that accepts the connection and never answers would otherwise hang this
      screen forever on a profile whose kind-0 arrived perfectly well.

      Resolving to null means no categories, no map and NO BUY BUTTON — it fails
      CLOSED, so an unreachable record never offers a purchase we cannot honour.
    */
    const withDeadline = Promise.race([
      fetchMerchantRecord(pubkey),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
    ])

    withDeadline
      .then((m) => {
        if (!cancelled) setRecord(m)
      })
      .catch(() => {
        if (!cancelled) setRecord(null)
      })
    return () => {
      cancelled = true
    }
  }, [pubkey])

  const copyHandle = async (nip05: string) => {
    try {
      await navigator.clipboard.writeText(nip05)
      setCopied(true)
      // Long enough to register as confirmation, short enough to be back to
      // normal before anyone reaches for it again. Matches BackupPages and
      // CashbackIssuePage, so a copy button behaves the same everywhere.
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard permission is not something a shopper can act on, and the
      // handle is on screen to be read. Failing silently beats an error about
      // a browser setting.
    }
  }

  // A handle that resolves to nobody. Said plainly rather than rendered as an
  // empty profile, which would look like a stall with nothing published.
  if (lookedUp === null) {
    return <Centered>No profile found for “{param}”.</Centered>
  }

  if (
    lookedUp === undefined ||
    branding === undefined ||
    record === undefined ||
    status === undefined
  ) {
    return <Centered>Loading…</Centered>
  }

  // Only a definite "customer" refuses. `unknown` falls through and renders
  // whatever kind-0 arrived, which for an unreachable relay is a name and a
  // picture with no Buy button — degraded, not wrong.
  if (status === 'customer') {
    return <Centered>This is a personal account, not a stall. There is no public profile to show.</Centered>
  }

  const name = branding.organizationName ?? shortPubkey(pubkey)
  // Their NIP-05 when they publish one, otherwise the npub. Unverified either
  // way — see MerchantBranding.nip05 — and the pubkey is what money is
  // addressed to, so the handle is a label rather than a credential.
  const handle = branding.nip05 ? handleLabel(branding.nip05) : npubOf(pubkey)
  /*
    What a shopper actually takes away — the full nip05, or the npub when a
    stall publishes no handle. NOT `handle` above, which is the DISPLAY form:
    `handleLabel` strips the domain ("@rosa") and `npubOf` shortens with an
    ellipsis, and either would paste as a string that resolves to nobody.

    Null only when the key itself is malformed, in which case there is nothing
    to hand over and both buttons stay away.
  */
  const shareHandle = branding.nip05 ?? npubFull(pubkey)
  const about = branding.storeDescription ?? record?.storeDescription

  /*
    Buying from YOURSELF is not a thing. A stall owner reaching their own
    profile — from their own coupon, their own receipt, or a shared link that
    came back round — would otherwise be offered a card purchase of their own
    voucher, which charges their own Stripe account and mints them a coupon they
    already back. The gateway would probably let them.

    `viewerPubkey` is passed by App, which already holds it. Comparing here
    rather than hiding the whole page: everything else on it is still true and
    still worth reading, and a stall checking how they look to a shopper is a
    reasonable errand.
  */
  const isSelf = viewerPubkey !== undefined && viewerPubkey === pubkey
  const acceptsCards = record?.acceptsCards === true && !isSelf

  return (
    <Screen>
      <BackLink to="/" label="Wallet" />

      <div className="overflow-hidden rounded-2xl border border-mono-200 bg-white dark:border-mono-800 dark:bg-mono-900">
        {branding.bannerUrl && (
          // Their own URL, so: no referrer, a placeholder while it loads, and a
          // dead link leaving a plain band rather than a broken-image icon.
          <RemoteImage
            src={branding.bannerUrl}
            className="h-24 w-full bg-mono-100 dark:bg-mono-800"
          />
        )}
        <div className="flex items-center gap-3 p-5">
          <Avatar src={branding.logoUrl} name={name} pubkey={pubkey} size="lg" />
          <div className="min-w-0 flex-1">
            {/* Tracking tightens as size goes up: at 18px the default spacing
                reads loose against the tighter handle beneath it. */}
            <p className="truncate text-lg font-semibold tracking-[-0.01em] text-mono-900 dark:text-mono-50">
              {name}
            </p>
            {handle && (
              <p className="truncate text-sm text-mono-500" title={pubkey}>
                {handle}
              </p>
            )}
          </div>

          {/* Both controls sit ON the card, beside what they act on, rather than
              as full-width buttons below the fold — the same arrangement, sizes
              and order as your own profile, because a stall's card and yours
              are the same object seen from two sides.

              Show, then Copy. Holding up a code is what you do with somebody in
              front of you, and it is the errand that cannot be done any other
              way; copying is the quieter one. */}
          {shareHandle && (
            <>
              <button
                type="button"
                onClick={() => setShowCode(true)}
                aria-label={`Show code for ${shareHandle}`}
                className={ICON_BUTTON}
              >
                <QrCode className="h-4 w-4" aria-hidden />
              </button>
              {/* Copies the FULL nip05 where there is one, not the label beside
                  it: `handleLabel` strips the domain for display ("@rosa"), and
                  pasting that resolves to nobody. Falls back to the npub, so the
                  button is never present with nothing to give. */}
              <button
                type="button"
                onClick={() => void copyHandle(shareHandle)}
                aria-label={copied ? 'Handle copied' : `Copy ${shareHandle}`}
                className={`${ICON_BUTTON} -mr-2`}
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-600" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
                {/* Announced without moving focus or stealing the label. */}
                <span className="sr-only" aria-live="polite">
                  {copied ? 'Copied' : ''}
                </span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Buying comes FIRST, above the description. It is the reason a shopper
          opened somebody's profile, and burying it under prose they may not
          read is how a working feature goes unused.

          The same `MerchantActions` as MerchantPage (#280), so the two screens
          cannot disagree about when Buy or Pay is available. Your own profile
          says so instead, where the buttons would be: it is the page a stall
          owner checks to see what shoppers see, and Buy/Pay against yourself
          is not a thing. */}
      {isSelf ? (
        <p className="mt-6 text-center text-sm text-mono-500">
          This is how your stall looks to a shopper.
        </p>
      ) : (
        <div className="mt-6">
          <MerchantActions pubkey={pubkey} acceptsCards={acceptsCards} viewerPubkey={viewerPubkey} />
        </div>
      )}

      {/* Leading is looser here than on the single-value rows below, because
          this is the only multi-line text on the page and 1.5 is what makes a
          paragraph readable rather than dense. The values below are one line
          each, where the same leading would just add gaps. */}
      {about && (
        <Field icon={Info} label="About">
          <p className="whitespace-pre-wrap leading-relaxed text-mono-900 dark:text-mono-50">
            {about}
          </p>
        </Field>
      )}

      {record?.categories && record.categories.length > 0 && (
        <Field icon={Tag} label="Sells">
          <p className="text-mono-900 dark:text-mono-50">{record.categories.join(' · ')}</p>
        </Field>
      )}

      {/* What their vouchers are denominated in. Worth showing to somebody about
          to buy one: a stall issuing in a currency the shopper does not hold is
          a fact better learned here than at the card form. */}
      {/* `Banknote`, not `Store`: this line is about MONEY, and a shopfront
          glyph beside "GBP" reads as another fact about the premises. `Store`
          is used elsewhere in the app for actual stalls, which is exactly what
          made it wrong here — the same icon meaning two things is worse than a
          plain one. */}
      {record?.issuanceCurrency && (
        <Field icon={Banknote} label="Vouchers issued in">
          <p className="text-mono-900 dark:text-mono-50">
            {record.issuanceCurrency.toUpperCase()}
          </p>
        </Field>
      )}

      {/* Where to find them, when they trade somewhere fixed. Renders nothing at
          all for a trader who moves around, which is the common case — no empty
          frame and no heading over a blank.

          NO RAW PUBKEY on this page, deliberately. An earlier draft printed the
          full 64 characters as "the only unforgeable thing here", which is true
          and is not a reason: nobody compares two 64-character strings by eye,
          so it bought no real safety and spent the bottom of a shopper's screen
          on noise. The handle above already names them, and the pubkey is in the
          URL for anyone who genuinely needs it. */}
      <LocationMap location={record?.location} label={name} className="mt-5" />

      {showCode && shareHandle && (
        <CodeDialog handle={shareHandle} name={name} onClose={() => setShowCode(false)} />
      )}
    </Screen>
  )
}

/** Their npub, shortened for DISPLAY. Null if the key is malformed. */
function npubOf(pubkey: string): string | null {
  const full = npubFull(pubkey)
  return full === null ? null : shortPubkey(full)
}

/**
 * Their npub in full, for copying and for the code.
 *
 * Separate from {@link npubOf} because the two must never be confused: that one
 * shortens with an ellipsis for a line of text, and a shortened key scans and
 * pastes as nothing.
 */
function npubFull(pubkey: string): string | null {
  try {
    return nip19.npubEncode(pubkey)
  } catch {
    return null
  }
}

/**
 * A 44px round target, matching your own profile card exactly.
 *
 * Copied deliberately rather than imported: `ProfilePage` keeps it private, and
 * hoisting it into the shared UI layer is a wider change than a design pass
 * should make. The value is the point — 44px is the minimum comfortable touch
 * target, and the focus ring keeps the control reachable without a pointer.
 */
const ICON_BUTTON =
  'pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mono-500 outline-none ring-mono-400 hover:text-mono-900 focus-visible:ring-2 dark:hover:text-mono-50'

/**
 * The stall's handle as a code, held up across a counter.
 *
 * A modal task, so it dims and pushes everything else back — `materialize`
 * scales and blurs it in as a real surface arriving rather than a flat fade.
 * `<dialog>` rather than a hand-rolled overlay: it brings focus trapping, Escape
 * to close, and inertness of the page behind it, none of which is worth
 * reimplementing.
 *
 * The code is WHITE-backed regardless of theme. A scanner reads dark-on-light,
 * and a code inverted for dark mode is a code that will not scan.
 */
function CodeDialog({
  handle,
  name,
  onClose,
}: {
  handle: string
  name: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  useEffect(() => {
    let live = true
    QRCode.toDataURL(handle, { width: 512, margin: 1 }).then(
      (url) => live && setDataUrl(url),
      () => live && setDataUrl(null),
    )
    return () => {
      live = false
    }
  }, [handle])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="materialize m-auto w-[calc(100%-2.5rem)] max-w-sm rounded-[20px] bg-transparent p-0 backdrop:bg-mono-950/50 backdrop:backdrop-blur-sm"
      // A click on the element itself rather than the card is a click on the
      // backdrop, which is a click outside.
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
    >
      <div className="material flex flex-col items-center gap-4 rounded-[20px] p-5 shadow-xl shadow-mono-950/20 ring-1 ring-mono-900/5 dark:ring-mono-50/10">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt={`Code for ${handle}`}
            className="w-full rounded-2xl bg-white p-4"
          />
        ) : (
          <p className="p-8 text-sm text-mono-500">The code could not be drawn.</p>
        )}
        <div className="w-full text-center">
          <p className="truncate font-semibold tracking-[-0.01em] text-mono-900 dark:text-mono-50">
            {name}
          </p>
          <p className="truncate text-sm text-mono-500">{handle}</p>
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

function Field({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Info
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="mt-5 flex gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-mono-400" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="sr-only">{label}: </span>
        {children}
      </div>
    </div>
  )
}
