import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Check, Copy, CreditCard, Send, Share2 } from 'lucide-react'
import { nip19 } from 'nostr-tools'

import {
  Button,
  Screen,
  BackLink,
  ListSection,
  SeeAll,
  EmptyRow,
  Centered,
  Pass,
  TransactionListItem,
} from '../components/ui'
import { listVouchers, transactionsWith, onWalletChanged, walletIsOpen } from '../lib/wallet'
import { findMerchantWithHistory, couponsFor, type Merchant } from '../lib/merchants'
import { toMerchantPass, EMPTY_BRANDING, type MerchantBranding } from '../lib/pass'
import { merchantBranding } from '../lib/branding'
import { fetchMerchantRecord, type MerchantProfile } from '../lib/merchant'
import { LocationMap } from '../components/LocationMap'
import type { WalletTransaction } from '../lib/transactions'
import { canShare, shareText } from '../lib/native'

/** How many transactions the summary list shows before deferring to a full page. */
const PREVIEW = 3

/**
 * One stall: who they are, what you can buy, and whatever you already have.
 *
 * ## This used to require a relationship, and that was the wrong shape
 *
 * The page was built from the customer's own coupons and history, and a visitor
 * holding neither was turned away with "No vouchers from this merchant." That
 * reads as an edge case and is actually the DEFAULT: every stall a customer has
 * not bought from yet, including the one whose QR they just scanned off a stall
 * sign. The person a purchase page exists for was the one person it refused.
 *
 * So the relationship is now a SECTION rather than a precondition. The stall's
 * identity comes first because it is how someone knows they scanned the right
 * sign, buying comes second because it is why they are here, and the coupons and
 * history appear underneath when there are any.
 *
 * ## What a stranger can actually see
 *
 * More than one would guess, because the stall record is already public: a
 * kind-30078 `imani:merchant` event is PLAINTEXT and readable over an
 * unauthenticated relay query, carrying the location, the description, the
 * categories and now `acceptsCards`. The kind-0 profile carries name and
 * picture the same way.
 *
 * `merchantBranding` tries the gateway first with `credentials: 'include'` and
 * falls back to the relay, so an unauthenticated visitor gets the relay answer
 * or `EMPTY_BRANDING`. That is why every branded field below is optional in
 * fact and not merely in type: a stranger's page must still be a page when the
 * only leg they can reach is the relay.
 */
export function MerchantPage() {
  const { pubkey = '' } = useParams()
  const navigate = useNavigate()
  const [merchant, setMerchant] = useState<Merchant | null | undefined>(undefined)
  const [couponCount, setCouponCount] = useState(0)
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [branding, setBranding] = useState<MerchantBranding>(EMPTY_BRANDING)
  const [record, setRecord] = useState<MerchantProfile | null | undefined>(undefined)

  useEffect(() => {
    const load = async () => {
      // A visitor with no wallet reaches this page by design — that is the
      // whole point of a QR on a stall sign. `listVouchers` goes through
      // `getWallet`, which THROWS when no store is open, so the relationship
      // half is skipped rather than attempted. Not a try/catch: an exception
      // here would be indistinguishable from a real storage failure.
      if (!walletIsOpen()) {
        setMerchant(null)
        setCouponCount(0)
        setTransactions([])
        return
      }
      const [rows, history] = await Promise.all([listVouchers(), transactionsWith(pubkey)])
      // Through the history too, or a merchant whose coupons are all spent bounces
      // off the `merchant === null` branch below with "No coupons from this
      // merchant." — over a screen whose whole other half is the history with them.
      setMerchant(findMerchantWithHistory(rows, history, pubkey) ?? null)
      // Rows, not merchant.groups[].vouchers — only the row carries token_id, and
      // that is what addresses a coupon's detail screen.
      setCouponCount(couponsFor(rows, pubkey).length)
      setTransactions(history)
    }
    load()
    return onWalletChanged(load)
  }, [pubkey])

  useEffect(() => {
    // Never rejects — an unbranded merchant falls back to the pass defaults.
    merchantBranding(pubkey).then(setBranding)
  }, [pubkey])

  useEffect(() => {
    // A SECOND record, and it has to be: the stall's own kind-30078 carries the
    // location and whether they take cards, while `branding` above is their
    // kind-0 profile. Neither carries the other's fields, so there is no one
    // fetch that answers both.
    //
    // `fetchMerchantRecord`, NOT `refreshMerchant` — that one ends in
    // `saveMerchant`, so browsing three shops would leave three foreign stall
    // records in this device's localStorage, which `clearMerchant` at logout
    // never removes. Their record is not ours to keep.
    let cancelled = false

    /*
     * A DEADLINE, because the page now waits for this before rendering
     * anything.
     *
     * `fetchMerchantRecord` never rejects, but it can hang: the relay query
     * underneath has no timeout of its own, and a customer holding twenty
     * coupons would sit on "Loading…" forever over a stall record they do not
     * need. That is a regression this screen introduced by gating render on a
     * second fetch, so the timeout belongs here rather than in the fetch.
     *
     * Resolving to null means no map and no Buy button, which is the same
     * degradation as an unreachable stall, and it fails CLOSED.
     */
    const withDeadline = Promise.race([
      fetchMerchantRecord(pubkey),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
    ])

    withDeadline
      .then((m) => {
        if (!cancelled) setRecord(m)
      })
      // A stall we cannot reach is still a stall. Losing the map and the Buy
      // button is the smallest possible degradation, and it degrades CLOSED:
      // no record means no card offer, never an offer we cannot honour.
      .catch(() => {
        if (!cancelled) setRecord(null)
      })
    return () => {
      cancelled = true
    }
  }, [pubkey])

  // Both loads must land before the page can tell "no relationship" apart from
  // "not loaded yet". Rendering earlier would flash a stranger's view at
  // somebody who holds twenty coupons.
  if (merchant === undefined || record === undefined) return <Centered>Loading…</Centered>

  // A key with no coupons, no history, and no stall record is not a stall at
  // all. Saying so beats rendering an empty profile for a mistyped npub.
  if (merchant === null && record === null) {
    return <Centered>No stall found for this address.</Centered>
  }

  const name = branding.organizationName
  const acceptsCards = record?.acceptsCards === true

  return (
    <Screen>
      <BackLink to="/" label="Merchants" />

      {merchant !== null ? (
        <div className="mb-6">
          <Pass pass={toMerchantPass(merchant, branding)} to={`/merchants/${pubkey}/coupons`} />
          <p className="mt-2 text-center text-sm text-mono-500">
            {couponCount === 1 ? '1 voucher' : `${couponCount} vouchers`} · tap to see them
          </p>
        </div>
      ) : (
        <StallHeader branding={branding} description={record?.storeDescription} />
      )}

      <div className="mb-6 grid gap-3">
        {/* Buying is offered to everyone who can be sold to, including someone
            who already holds coupons and wants more — that is the top-up case,
            and it needs no separate screen.

            `/buy/:pubkey` is NOT BUILT YET. It waits on the funds-flow
            correction in `payment-adapter` (its ADR 0001): until a Checkout
            Session is created on the stall's connected account, a purchase
            would charge the platform and put Imani in the money path, which is
            the one thing the design rules out. The button is gated on
            `acceptsCards`, which no stall publishes yet, so nothing renders a
            route to nowhere in the meantime. */}
        {acceptsCards && (
          <Button size="lg" onClick={() => navigate(`/buy/${pubkey}`)}>
            <CreditCard className="mr-2 h-5 w-5" /> Buy a voucher
          </Button>
        )}

        {/* The other way into /send: the voucher is already settled by being on
            this page, so it opens on the recipient rather than on the picker.
            Hidden with nothing to send — a button that can only refuse is worse
            than no button. */}
        {couponCount > 0 && (
          <Button size="lg" variant={acceptsCards ? 'outline' : 'primary'} onClick={() => navigate(`/send?from=${pubkey}`)}>
            <Send className="mr-2 h-5 w-5" /> Send
          </Button>
        )}

        <ShareMerchant pubkey={pubkey} nip05={branding.nip05} />
      </div>

      {/* Renders nothing when the stall has no location, which is the common
          case for a trader who moves around. Named with the merchant's own
          name when we have one, so the heading reads "Find Marlow Books"
          rather than a pronoun for a stall the customer just opened. */}
      <LocationMap location={record?.location} label={name} className="mb-6" />

      {/* Only for someone who has a history to show. An empty state is worth
          rendering for a customer whose list could fill up, and is noise to a
          stranger who has never dealt with this stall. */}
      {merchant !== null && (
        <ListSection
          title="Transactions"
          action={
            transactions.length > PREVIEW ? (
              <SeeAll to={`/merchants/${pubkey}/transactions`} count={transactions.length} />
            ) : undefined
          }
        >
          {transactions.length === 0 ? (
            <EmptyRow>Nothing yet.</EmptyRow>
          ) : (
            transactions.slice(0, PREVIEW).map((tx) => <TransactionListItem key={tx.id} tx={tx} />)
          )}
        </ListSection>
      )}
    </Screen>
  )
}

/**
 * Who this stall is, for somebody who holds nothing of theirs.
 *
 * Deliberately not a `Pass`. A pass shows a balance and opens a coupon list,
 * and both would be lies here: there is no balance and there is nothing behind
 * the tap. What a stranger needs is the same thing the sign outside gave them —
 * a name and a face — so they can tell they are in the right place.
 *
 * Every field is allowed to be missing. An unbranded stall reachable only over
 * the relay still gets a usable page, which is the point of not requiring the
 * gateway leg.
 */
function StallHeader({
  branding,
  description,
}: {
  branding: MerchantBranding
  description?: string
}) {
  const name = branding.organizationName
  return (
    <div className="mb-6 text-center">
      {branding.bannerUrl && (
        <img
          src={branding.bannerUrl}
          alt=""
          /* `rounded-2xl` matches the Pass a customer with coupons sees in this
             same slot, so the two states of this page are the same shape rather
             than two designs. */
          className="mb-4 h-28 w-full rounded-2xl object-cover"
          loading="lazy"
        />
      )}
      {branding.logoUrl && (
        <img
          src={branding.logoUrl}
          alt=""
          /* A ring rather than a border: it sits outside the image, so a logo
             with a light edge still reads as a distinct object against the
             page. Pulled up over the banner when there is one, which is the
             arrangement every profile in the world uses and therefore the one
             nobody has to learn. */
          className={`mx-auto h-16 w-16 rounded-full object-cover ring-1 ring-mono-200 dark:ring-mono-800 ${
            branding.bannerUrl ? '-mt-12 mb-3 bg-mono-50 dark:bg-mono-950' : 'mb-3'
          }`}
          loading="lazy"
        />
      )}
      {/* Tightened tracking and leading, both size-specific. The fallback is
          deliberately plain: "This stall" is what an unbranded stall is, and
          inventing something friendlier would be putting words in their mouth. */}
      <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">
        {name ?? 'This stall'}
      </h1>
      {branding.nip05 && (
        <p className="mt-1 text-[15px] text-mono-500">{branding.nip05}</p>
      )}
      {description && (
        <p className="mx-auto mt-3 max-w-prose text-[15px] leading-relaxed text-mono-500">
          {description}
        </p>
      )}
    </div>
  )
}

/**
 * Hand this stall to somebody else.
 *
 * What goes out is the merchant's own handle — the full `name@domain` from
 * their kind-0, or their npub when they have not claimed one — and nothing
 * else. A bare string is what a wallet can consume: whoever receives it pastes
 * it into Scan or Send and lands on this same merchant. Wrapped in a sentence
 * it would read better and paste worse.
 *
 * Copy stands in where there is no share sheet, so the slot is never dead in a
 * desktop browser. Either way it is one button doing one job, and it says which.
 */
function ShareMerchant({ pubkey, nip05 }: { pubkey: string; nip05?: string }) {
  const [copied, setCopied] = useState(false)

  // Encoding is fallible on a malformed key; without either form there is
  // nothing to hand over, so the button does not appear.
  const handle =
    nip05 ??
    (() => {
      try {
        return nip19.npubEncode(pubkey)
      } catch {
        return null
      }
    })()

  if (handle === null) return null

  const shareable = canShare()

  const act = async () => {
    if (await shareText(handle)) return
    try {
      await navigator.clipboard.writeText(handle)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard denied. Nothing a message would let them do differently.
    }
  }

  return (
    <Button size="lg" variant="outline" onClick={act}>
      {shareable ? (
        <Share2 className="mr-2 h-5 w-5" />
      ) : copied ? (
        <Check className="mr-2 h-5 w-5" />
      ) : (
        <Copy className="mr-2 h-5 w-5" />
      )}
      <span aria-live="polite">
        {shareable ? 'Share' : copied ? 'Copied' : 'Copy'}
      </span>
    </Button>
  )
}
