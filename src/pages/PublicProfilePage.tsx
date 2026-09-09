import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Banknote, Check, Copy, CreditCard, Info, Tag } from 'lucide-react'
import { nip19 } from 'nostr-tools'

import { Avatar, BackLink, Button, Centered, Screen } from '../components/ui'
import { LocationMap } from '../components/LocationMap'
import { merchantBranding } from '../lib/branding'
import { handleLabel, shortPubkey } from '../lib/format'
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
export function PublicProfilePage() {
  const { pubkey = '' } = useParams()
  const navigate = useNavigate()
  const [copied, setCopied] = useState(false)
  const [branding, setBranding] = useState<MerchantBranding>()
  const [record, setRecord] = useState<MerchantProfile | null>()
  const [status, setStatus] = useState<MerchantStatus>()

  useEffect(() => {
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

  if (branding === undefined || record === undefined || status === undefined) {
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
  const about = branding.storeDescription ?? record?.storeDescription
  const acceptsCards = record?.acceptsCards === true

  return (
    <Screen>
      <BackLink to="/" label="Wallet" />

      <div className="overflow-hidden rounded-2xl border border-mono-200 bg-white dark:border-mono-800 dark:bg-mono-900">
        {branding.bannerUrl && (
          // Their own URL, so: no referrer, and a dead link leaves a plain band
          // rather than a broken-image icon.
          <img
            src={branding.bannerUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="h-24 w-full bg-mono-100 object-cover dark:bg-mono-800"
          />
        )}
        <div className="flex items-center gap-4 p-5">
          <Avatar src={branding.logoUrl} name={name} pubkey={pubkey} size="xl" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold text-mono-900 dark:text-mono-50">{name}</p>
            {handle && (
              <p className="truncate text-sm text-mono-500" title={pubkey}>
                {handle}
              </p>
            )}
          </div>
          {/* Copying the handle is how a shopper takes a stall away with them —
              into a message, a note, or the wallet's own search. Only rendered
              for a stall that HAS one: a button that copies nothing is worse
              than no button.

              Copies the FULL nip05, not the label beside it. `handleLabel`
              strips the domain for display ("@rosa"), and pasting that
              elsewhere resolves to nobody — the domain is the half that makes
              it an address. */}
          {branding.nip05 && (
            <button
              type="button"
              onClick={() => void copyHandle(branding.nip05 as string)}
              aria-label={copied ? 'Handle copied' : `Copy ${branding.nip05}`}
              className="pressable shrink-0 rounded-xl p-2 text-mono-400 hover:text-mono-900 dark:hover:text-mono-50"
            >
              {copied ? (
                <Check className="h-5 w-5 text-green-600" aria-hidden />
              ) : (
                <Copy className="h-5 w-5" aria-hidden />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Buying comes FIRST, above the description. It is the reason a shopper
          opened somebody's profile, and burying it under prose they may not
          read is how a working feature goes unused.

          Gated on `acceptsCards`, exactly as MerchantPage is: the flag is the
          only channel a stranger has, because imani-merchant is self-scoped and
          nobody can ask about someone else's charges_enabled. A stall that has
          not connected Stripe shows no button rather than one that can only
          fail. */}
      {acceptsCards && (
        <Button size="lg" className="mt-6 w-full" onClick={() => navigate(`/buy/${pubkey}`)}>
          <CreditCard className="mr-2 h-5 w-5" aria-hidden /> Buy a voucher
        </Button>
      )}

      {about && (
        <Field icon={Info} label="About">
          <p className="whitespace-pre-wrap text-mono-900 dark:text-mono-50">{about}</p>
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
    </Screen>
  )
}

/** Their npub, or null if the key is malformed. Encoding is fallible. */
function npubOf(pubkey: string): string | null {
  try {
    return shortPubkey(nip19.npubEncode(pubkey))
  } catch {
    return null
  }
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
