import type { EventTemplate } from 'nostr-tools'

import { newestAddressable } from './relay'
import { str } from './branding'
import {
  DEFAULT_VALIDITY_DAYS,
  MERCHANT_D_TAG,
  MERCHANT_KIND,
  NEVER_EXPIRES,
  VALIDITY_DAYS,
  validValidityDays,
} from '@imani/merchant-record'

// The record's kind and the validity rules live in `@imani/merchant-record`, shared with the
// purchase issuer so a card coupon gets the same term as one sold over the counter (#312).
export {
  DEFAULT_VALIDITY_DAYS,
  MAX_VALIDITY_DAYS,
  MERCHANT_D_TAG,
  MERCHANT_KIND,
  MIN_VALIDITY_DAYS,
  NEVER_EXPIRES,
  VALIDITY_DAYS,
  validValidityDays,
  validityFromRecord,
} from '@imani/merchant-record'

/**
 * The merchant side of an identity.
 *
 * A wallet user is a merchant if — and only if — their key has published a live
 * `imani:merchant` record. There is deliberately NO separate role flag: two
 * places to say the same thing is two places to disagree, and the metadata is
 * what Sell and Redeem actually need. "Is this a merchant" is a question about
 * the data, not a field beside it.
 *
 * Stored as a kind-30078 parameterised-replaceable event, `d=imani:merchant`.
 * That kind and tag are possa-merchant's own convention (its
 * `lib/merchant/writeContract.ts`), kept so the two apps read each other's
 * records rather than forking the identity.
 *
 * NOT stored on the gateway. possa-merchant posts this to
 * `POST /api/v1/merchant/onboarding/complete`, and this file used to say that
 * endpoint "does not exist on this stack" because gateway-portal answered 403
 * with an empty body for `/api/v1/merchant/*`.
 *
 * That inference was WRONG, and the correction is worth keeping. `merchant-
 * service` is deployed on both stacks and nginx routes `/api/v1/merchant*` to
 * it; the 403 came from the DEV PROXY, which had no rule for the prefix and let
 * it fall into the `/api` catch-all onto gateway-portal — a service that
 * refuses an unknown path exactly the way it refuses an unpermitted one. See
 * `src/lib/stripeAccount.ts` for the full account and
 * `src/lib/__tests__/devProxy.test.ts` for the guard.
 *
 * The relay is STILL the only store for this record, which is the part that
 * actually mattered and is why `refreshMerchant` reads from the relay directly
 * rather than through the gateway's nostrdb cache. Whether that onboarding
 * endpoint exists was never the reason; a public, self-asserted profile
 * belongs on the relay either way.
 *
 * NOTHING SECRET GOES IN HERE, for the same reason as `Profile`: this is public
 * metadata, published to a relay, readable by anyone.
 */
export interface MerchantProfile {
  pubkey: string
  /** A merchant who has stopped trading. Kept so the record can be retired without deleting it. */
  active: boolean
  businessType?: string
  categories: string[]
  location?: string
  storeDescription?: string
  /**
   * The currency every coupon is issued in.
   *
   * Load-bearing rather than cosmetic: Sell and Redeem have no amount to ask for
   * without it, and possa-merchant shows an "onboarding required" empty state on
   * every action page when it is missing. Required at registration for that
   * reason.
   */
  issuanceCurrency: string
  /** How long an issued coupon stays valid. Sent to the portal as `expiry_days`. */
  voucherValidityDays: number
  /**
   * Whether this stall can be paid by card.
   *
   * Published on the stall's own public record because it is the ONLY channel a
   * stranger has. Every `imani-merchant` endpoint is self-scoped behind
   * `MerchantAuth.requirePubkey()` — `charges_enabled` exists there, but a
   * merchant can read only their own, and there is no pubkey parameter to ask
   * about anyone else's. A shopper who scanned a QR has no session and no
   * relationship, so a gateway answer is not available to them at any price
   * short of punching a hole in that self-scoping.
   *
   * SELF-ASSERTED, and safe to be, because it is checked where it counts:
   * creating a Checkout Session goes through `payment-adapter`, which knows the
   * real `chargesEnabled` and refuses. A stale or wrong flag costs a stranger
   * one failed tap; it can never take a payment that should not have happened.
   *
   * Set by connecting Stripe and cleared by disconnecting, so it is not a
   * separate thing for a stall to remember.
   */
  acceptsCards?: boolean
  /**
   * The stall opted in to search-engine indexing of its gifting page (#410 G1).
   * Like `acceptsCards`, only a literal `true` counts, and absent means no.
   */
  giftingIndexable?: boolean
  /** When this record was last written locally, ms. For display only. */
  updatedAt: number
  /**
   * `created_at` of the kind-30078 this record's contents came from, in SECONDS.
   *
   * The ordering key for merges, exactly as `Profile.eventAt` is — see the note
   * on `mergeMerchantEvent`. A parameterised-replaceable event is replaced by
   * newest-created_at, so this is the only field that can decide which of two
   * copies wins.
   */
  eventAt?: number
}

/**
 * Business categories, from possa-merchant's `BusinessStep.tsx`.
 *
 * A fixed list rather than free text so the values stay comparable across the
 * two apps — they are published to a relay that neither of them owns.
 */
export const CATEGORIES = [
  'food',
  'retail',
  'services',
  'hospitality',
  'transport',
  'entertainment',
  'health',
  'education',
  'technology',
  'other',
] as const

/**
 * The currencies offered before a merchant types anything, from
 * possa-merchant's `IssuanceStep.tsx`. Not the limit: `searchCurrencies` in
 * ./currencies reaches every code the runtime knows.
 */
export const CURRENCIES = [
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'JPY',
  'CAD',
  'AUD',
  'ZAR',
  'NGN',
  'KES',
  'XOF',
  'XAF',
] as const

export const DEFAULT_CURRENCY = 'EUR'

/**
 * The terms to offer as chips, this stall's own first.
 *
 * The default leads rather than sitting among the presets because it is the
 * answer almost every sale takes: the common case should be a chip that is
 * already selected, not one to find. Deduped, so a stall defaulting to 60 is
 * not offered 60 twice.
 */
export function validityChoices(defaultDays: number): number[] {
  return [
    defaultDays,
    ...[NEVER_EXPIRES, ...VALIDITY_DAYS].filter((days) => days !== defaultDays),
  ]
}

/**
 * The subset this app's forms edit.
 *
 * Narrower than it was: `businessType` and `storeDescription` are no longer
 * asked for, because the profile's display name and `about` are the same two
 * facts and were being asked for twice. They stay on `MerchantProfile` and in
 * both event functions on purpose — records written by possa-merchant, or by an
 * older build of this one, carry them, and a merge that dropped them would
 * quietly erase another client's data on the next save.
 */
export type MerchantFields = Pick<
  MerchantProfile,
  'active' | 'categories' | 'location' | 'issuanceCurrency'
> & {
  /**
   * Null only while a custom term is half-typed. `MerchantProfile` keeps a
   * number — a stall always has a default — but the form has to be able to
   * hold "not a validity yet" for as long as the field is open, and saying so
   * in the type is what lets one `merchantFieldsValid` gate both Save buttons.
   */
  voucherValidityDays: number | null
}

/**
 * The one rule that gates submission: a stall has to sell something, in a
 * currency. Everything else is optional — a one-line stall with no website is
 * still a merchant.
 *
 * Plus the validity, which is only ever absent mid-edit: a form that saved an
 * unfinished custom term would silently fall back to a number the merchant did
 * not choose, and every coupon after that would carry it.
 */
export function merchantFieldsValid(fields: MerchantFields): boolean {
  return (
    fields.categories.length > 0 &&
    fields.issuanceCurrency.trim() !== '' &&
    fields.voucherValidityDays !== null
  )
}

/** A merchant record with nothing filled in yet. */
export function emptyMerchant(pubkey: string): MerchantProfile {
  return {
    pubkey,
    active: true,
    categories: [],
    issuanceCurrency: DEFAULT_CURRENCY,
    voucherValidityDays: DEFAULT_VALIDITY_DAYS,
    updatedAt: 0,
  }
}

// Same `imani-wallet:` prefix and pubkey scoping as lib/profile.ts, so a device
// that has held two identities keeps them apart.
const key = (pubkey: string) => `imani-wallet:merchant:${pubkey}`

export function loadMerchant(pubkey: string): MerchantProfile | null {
  try {
    const raw = localStorage.getItem(key(pubkey))
    if (!raw) return null
    const parsed = JSON.parse(raw) as MerchantProfile
    // A record written by an older build, or hand-edited, must not crash every
    // render. `categories` is checked too because the UI maps over it.
    if (!parsed || typeof parsed.pubkey !== 'string') return null
    return { ...parsed, categories: Array.isArray(parsed.categories) ? parsed.categories : [] }
  } catch {
    return null
  }
}

export function saveMerchant(merchant: MerchantProfile): void {
  localStorage.setItem(key(merchant.pubkey), JSON.stringify(merchant))
}

/**
 * Forget the local merchant record.
 *
 * Called from logout beside `clearProfile`. Without it the next account
 * registered on this device inherits a merchant home screen from the previous
 * one, having published no merchant record of its own.
 */
export function clearMerchant(pubkey: string): void {
  localStorage.removeItem(key(pubkey))
}

/**
 * Is this identity trading as a merchant?
 *
 * A type predicate so callers get the narrowed record for free — the screens
 * that ask this question all need the metadata immediately afterwards, and
 * `merchant!` at every one of those call sites would be an assertion this
 * function has already checked.
 */
export function isMerchant(merchant: MerchantProfile | null): merchant is MerchantProfile {
  return merchant !== null && merchant.active
}

/** The permission gateway-portal demands of anything that issues a coupon. */
export const COUPON_ISSUE = 'coupon:issue'

/**
 * May this session open the trading screens?
 *
 * Two questions that must not collapse into one: the NAP session says what the
 * key MAY do, the stall record says what the stall IS. Sell needs both — the
 * permission, and the currency and validity to issue in — so this is `isMerchant`
 * ANDed with the session's authority, and stays a type predicate on `merchant`
 * because every screen behind it dereferences the record immediately.
 *
 * This is affordance only. The boundary is `@PreAuthorize("hasAuthority('coupon:issue')")`
 * on gateway-portal's PortalVoucherController; a page that lied to itself here
 * would still get a 403 from the one that counts.
 *
 * An empty permission list is a denial like any other. It briefly was not — while
 * the deployed gateway predated the ACL resolver, "no permissions" meant "this
 * deployment cannot answer yet", and failing closed on it would have taken Sell
 * away from every merchant on the stack. `deploy/compose.override.yml` now pins a
 * gateway that answers, so the exception has nothing left to protect and treating
 * silence as consent is exactly what an authorization check must not do.
 */
export function canTrade(
  permissions: readonly string[],
  merchant: MerchantProfile | null,
): merchant is MerchantProfile {
  return permissions.includes(COUPON_ISSUE) && isMerchant(merchant)
}

/**
 * The kind-30078 event to publish.
 *
 * Empty fields are omitted rather than sent as "", for the same reason
 * `buildProfileEvent` omits them: a replaceable event replaces its predecessor
 * wholesale, so an empty string is a positive assertion that the field is blank.
 */
export function buildMerchantEvent(merchant: MerchantProfile): EventTemplate {
  const content: Record<string, unknown> = {
    active: merchant.active,
    categories: merchant.categories,
    issuanceCurrency: merchant.issuanceCurrency,
    voucherValidityDays: merchant.voucherValidityDays,
  }
  const put = (k: string, v?: string) => {
    if (v !== undefined && v.trim() !== '') content[k] = v.trim()
  }

  put('businessType', merchant.businessType)
  put('location', merchant.location)
  put('storeDescription', merchant.storeDescription)

  // Only when TRUE. Absent means "this stall does not take cards", which is
  // also what an older client that never knew the field publishes, so the two
  // agree rather than needing to be told apart.
  if (merchant.acceptsCards === true) content.acceptsCards = true
  if (merchant.giftingIndexable === true) content.giftingIndexable = true

  return {
    kind: MERCHANT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', MERCHANT_D_TAG]],
    content: JSON.stringify(content),
  }
}

/**
 * Merge an event payload over a stored record.
 *
 * The `createdAt` guard is the same one `mergeKind0` carries, and it is here for
 * the same observed reason: a read that returns an older event must not undo a
 * newer local edit. `updatedAt` cannot stand in for it — a local save and a
 * relay event have unrelated clocks and unrelated meanings.
 *
 * Absent fields leave the existing value alone. A record written by another
 * client that does not know about every field must not silently wipe the rest.
 */
export function mergeMerchantEvent(
  merchant: MerchantProfile,
  content: string,
  createdAt = 0,
): MerchantProfile {
  if (createdAt > 0 && createdAt <= (merchant.eventAt ?? 0)) return merchant

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(content) as Record<string, unknown>
  } catch {
    return merchant
  }

  // Only strings survive, and only from the fixed list. These values are
  // attacker-controllable — anyone can publish a kind-30078 claiming to be you —
  // and they are rendered as chips and used to label money.
  const categories = Array.isArray(parsed.categories)
    ? parsed.categories.filter((c): c is string => typeof c === 'string')
    : merchant.categories

  return {
    ...merchant,
    // Only an explicit `false` deactivates. A record missing the field is a
    // record from a client that does not know about it, not a retirement.
    active: typeof parsed.active === 'boolean' ? parsed.active : merchant.active,
    businessType: str(parsed.businessType) ?? merchant.businessType,
    categories,
    location: str(parsed.location) ?? merchant.location,
    storeDescription: str(parsed.storeDescription) ?? merchant.storeDescription,
    issuanceCurrency: str(parsed.issuanceCurrency) ?? merchant.issuanceCurrency,
    voucherValidityDays:
      validValidityDays(parsed.voucherValidityDays) ?? merchant.voucherValidityDays,
    // Absent means false, NOT "keep what we had". Unlike `active`, this field
    // tracks a live external fact — whether Stripe will accept a charge — and a
    // record that stops asserting it has stopped being evidence for it. Holding
    // the old value would keep a Buy button alive on a stall that disconnected.
    acceptsCards: parsed.acceptsCards === true,
    giftingIndexable: parsed.giftingIndexable === true,
    updatedAt: Date.now(),
    eventAt: createdAt > 0 ? createdAt : merchant.eventAt,
  }
}

/**
 * Is SOMEONE ELSE trading as a merchant?
 *
 * The same question `isMerchant` answers about the signed-in user, asked about a
 * pubkey we do not own: has that key published a live `imani:merchant` record.
 * There is still no role flag anywhere to read — see this module's header — so
 * the record itself is the answer, and an unparseable one still counts, because
 * publishing it is the act that makes someone a merchant. Only an explicit
 * `active: false` retires them.
 *
 * Cached per session and keyed by pubkey: the avatar asks this every time it
 * renders and a coupon deck renders the same issuer on every card. Only a
 * POSITIVE answer is cached, for the reason `merchantBranding` gives at length —
 * a lookup that lost a race with login, or a relay that was briefly unreachable,
 * would otherwise pin "not a merchant" on a real stall for the life of the
 * document, and the badge would stay missing until the user reloaded.
 *
 * Never rejects. A badge is decoration; nobody should see an error over one.
 */
const merchantCache = new Map<string, Promise<MerchantStatus>>()

/**
 * Three answers, not two.
 *
 * `customer` means the relay was asked and holds no live merchant record.
 * `unknown` means it could not be asked at all. Collapsing those two into
 * `false` is exactly the confusion that let a foreign coupon through to a
 * merchant during an outage — a decoration can treat them alike, a guard on the
 * money path cannot.
 */
export type MerchantStatus = 'merchant' | 'customer' | 'unknown'

export function merchantStatus(pubkey: string): Promise<MerchantStatus> {
  const key = pubkey.toLowerCase()
  let pending = merchantCache.get(key)
  if (!pending) {
    pending = fetchMerchantStatus(key).then((status) => {
      if (status !== 'merchant') merchantCache.delete(key)
      return status
    })
    merchantCache.set(key, pending)
  }
  return pending
}

/**
 * The lenient reading, for everything that only wants to draw a badge.
 *
 * `unknown` reads as "no" here deliberately: an avatar that threw, or that
 * showed a merchant chip on a key it could not check, would be worse than one
 * that quietly stays plain until the relay answers.
 */
export function isMerchantPubkey(pubkey: string): Promise<boolean> {
  return merchantStatus(pubkey).then((status) => status === 'merchant')
}

async function fetchMerchantStatus(pubkey: string): Promise<MerchantStatus> {
  // The copy we already hold, first. For the signed-in user that is always
  // present — `refreshMerchant` saved it at login — so their own badge costs no
  // round trip at all. Nothing is saved for anyone else: their record is not
  // ours to keep, and the session cache above is enough.
  if (isMerchant(loadMerchant(pubkey))) return 'merchant'

  try {
    const event = await newestAddressable(pubkey, MERCHANT_KIND, MERCHANT_D_TAG)
    if (event === null) return 'customer'
    return isMerchant(mergeMerchantEvent(emptyMerchant(pubkey), event.content, event.created_at))
      ? 'merchant'
      : 'customer'
  } catch {
    // The relay could not be reached, or answered something unusable. Nothing
    // was learned about this key, and saying so is the whole point.
    return 'unknown'
  }
}

/**
 * Reconcile the stored record with the relay, as `refreshProfile` does for kind-0.
 *
 * Never throws: an unreachable relay means we show the copy we already have,
 * which is the entire reason a local copy exists. Returns null when this key has
 * never published a merchant record AND holds none locally — that is the
 * "customer" answer, and it is a legitimate result rather than a failure.
 */
export async function refreshMerchant(pubkey: string): Promise<MerchantProfile | null> {
  const current = loadMerchant(pubkey)
  try {
    const event = await newestAddressable(pubkey, MERCHANT_KIND, MERCHANT_D_TAG)
    if (event === null) return current

    const merged = mergeMerchantEvent(current ?? emptyMerchant(pubkey), event.content, event.created_at)
    // Unchanged when the fetched event was not newer — no write, no churn.
    if (current !== null && merged === current) return current

    saveMerchant(merged)
    return merged
  } catch {
    return current
  }
}

/**
 * Another merchant's stall record, fetched and NOT stored.
 *
 * `refreshMerchant` is the wrong call for somebody else's stall: it ends in
 * `saveMerchant`, which writes to `localStorage` under that pubkey's key. A
 * customer browsing three shops would leave three foreign stall records on
 * their device — records that `loadMerchant` then answers with, and that
 * `clearMerchant` (called at logout for the signed-in key alone) never removes.
 * Caught while wiring the location map, before it shipped.
 *
 * So this reads and returns, keeping nothing. Their record is not ours to hold.
 *
 * Never throws: an unreachable relay means no location, and a stall the map
 * cannot place still has coupons and history worth showing.
 */
export async function fetchMerchantRecord(pubkey: string): Promise<MerchantProfile | null> {
  try {
    const event = await newestAddressable(pubkey, MERCHANT_KIND, MERCHANT_D_TAG)
    if (event === null) return null
    const merged = mergeMerchantEvent(emptyMerchant(pubkey), event.content, event.created_at)
    // `mergeMerchantEvent` clamps relay-sourced values because a kind-30078 is
    // attacker-controllable — anyone can publish one claiming to be this key.
    // Nothing here is trusted beyond being displayed.
    return isMerchant(merged) ? merged : null
  } catch {
    return null
  }
}
