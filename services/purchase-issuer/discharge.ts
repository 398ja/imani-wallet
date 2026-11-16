/**
 * Working off the debts a purchase creates.
 *
 * `payment-adapter` records that a card purchase was paid and is undischarged.
 * This reads those records, mints, delivers, and marks them done — and every
 * decision here is about what to do when one of those steps does not work.
 *
 * ## The rule everything follows
 *
 * **An Obligation is discharged by confirmed issuance, never by an attempt.**
 * `imani-woo` ADR 0009 learned this the expensive way: a merchant ticking a box
 * before sending left a customer who had paid for nothing, and no part of the
 * system could tell. The same shape applies to a machine — marking a debt done
 * because a call was made, rather than because it succeeded, is the same bug
 * with a faster actor.
 *
 * So the only path to `discharged` runs through a coupon that exists and a
 * delivery that returned. Everything else leaves the debt standing, which is
 * recoverable, and is the whole reason payment is recorded before issuance
 * (ADR 0010).
 */

import {
  IssuanceFailed,
  issueAsStall,
  purchaseIdempotencyKey,
  type IssuedCoupon,
  type StallCredential,
} from './issuer'
import { checkDelegation, couponExpiresAtMs, delegatedWarrant } from './delegatedWarrant'
import type { StallValidity } from './stallValidity'
import { DeliveredUnconfirmed, DeliveryRefused, deliver, type Recipient } from './delivery'
import type { CardSale } from './saleRecord'
import { formatGiftLink, giftLockFor, openSeal, SealRefused, verifyLockedGift, type GiftLock } from './giftLock'
import { handBuyerTheGift, publishLinkWrap, sendClaimEmail, sendCodeEmail, type GiftPorts } from './giftDelivery'
import type { GiftDelivery } from './purchasesApi'
import { getPublicKey } from 'nostr-tools'
import { displayDate, tokenMintUrl } from './giftTracker'
import { balanceUrl, cleanShopUrl, codeLockFor, depositBody, depositCode, depositorOf, displayCode, verifyCodePart } from './codeGift'
import { hexToBytes } from '@noble/hashes/utils'

/** One coupon a stall owes because a card payment cleared. */
export interface Obligation {
  /** Stable across retries; Stripe's event id upstream. */
  id: string
  /**
   * Stamped onto the send so the discharge can be verified.
   *
   * Comes from the service that recorded the debt, never invented here: an id
   * this service chose at delivery time would verify only that this service
   * did something, which is what it already claims.
   */
  paymentRequestId: string
  stallPubkey: string
  faceValue: number
  faceUnit: string
  faceDecimals: number
  memo: string
  recipient: Recipient
  /** How many times issuance has already been tried. */
  attempts: number
  /**
   * The processor's record of the payment. Carried inside the coupon's signed
   * warrant as `ref` so the stall can reconcile it; not evidence.
   */
  processorReference?: string | null
  /**
   * A gifting-site gift's delivery (#410). `self` is delivered exactly like a wallet purchase.
   * `handle` and `email` are MINTED locked (G14: to the recipient key or L, refund = the buyer's
   * key, locktime x), verified, delivered, and handed back to the buyer; never minted plain.
   */
  gift?: { kind: 'self' | 'handle' | 'email'; delivery?: GiftDelivery | null; draftId?: string | null } | null
}

/** How many passes a minted gift may fail to deliver before it is parked for a person. */
export const GIFT_MAX_ATTEMPTS = 40

/**
 * What a minted coupon still owes after this pass, for the delivery outbox (imani-wallet#274):
 * the sale record, when it did not land inline.
 */
export interface Minted {
  issuerId: string
  /** The sale record, or null when it was filed inline (or there is no `fileSale` port). */
  pendingSale: CardSale | null
}

export type Outcome =
  | ({ kind: 'discharged'; voucherId: string; eventId?: string } & Minted)
  /** Issued but not delivered: value exists and has not reached anyone. */
  | ({
      kind: 'undelivered'
      voucherId: string
      reason: string
      /**
       * The DM DID go out, but the gateway did not confirm it recorded the delivery
       * (imani-wallet#287/#289). Still owed to the outbox: the discharge is not confirmed.
       */
      delivered?: true
      /** gateway-core refused the receipt for good (core#163): park, never retry. */
      refused?: true
    } & Minted)
  /**
   * gc refused 409 UNRECORDED (gc#232): this payment's warrant nonce was spent by a run that never
   * recorded its voucher. Unknown whether a coupon exists, so never retried: parked for a person.
   */
  | { kind: 'unrecorded'; reason: string }
  /**
   * Nothing minted as far as we know. The debt stands and can be tried again.
   *
   * `ambiguous` when the request may have reached the gateway and minted
   * anyway (network error, timeout, 5xx). The claim is then left to lapse
   * rather than released, so the retry comes after anything in flight has
   * settled and the idempotency key can answer it (imani-wallet#96).
   */
  | { kind: 'owed'; reason: string; ambiguous: boolean }
  /** Nothing minted and retrying cannot help. Needs a person. */
  | { kind: 'blocked'; reason: string }
  /**
   * A locked gift (#410 G14) exists and did not reach its recipient (or its buyer) this pass.
   * `park`: never retry (the minted token is not the lock asked for, or a refusal is permanent).
   * Otherwise the claim is left to lapse: the retry re-mints under the same idempotency key and
   * warrant nonce (gc replays the same voucher), and every delivery step is idempotent.
   */
  | ({ kind: 'gift_undelivered'; voucherId: string; reason: string; park: boolean } & Minted)
  /** No credential for this stall. Ordinary, not an error. */
  | { kind: 'manual' }
  /**
   * Nothing minted, and nothing automatic should try again: the stall's term cannot be honoured by
   * a delegated card coupon (never expires, or outlives the delegation), or its record stayed
   * unreadable past `VALIDITY_MAX_ATTEMPTS` (imani-wallet#312). Parked NEEDS_ATTENTION so an
   * operator refunds or issues by hand, rather than BLOCKED with nobody looking.
   */
  | { kind: 'attention'; reason: string }

export interface Ports {
  credentialFor(stallPubkey: string): Promise<StallCredential | null>
  /** Fetch a token for a coupon whose mint had not finished. */
  tokenFor(credential: StallCredential, voucherId: string): Promise<string>
  now(): number
  sleep(ms: number): Promise<void>
  /**
   * File the card sale into the stall's own ledger (imani-wallet#275, `saleRecord.ts`). Optional:
   * absent, nothing is filed. Must never throw; its result never changes the outcome.
   */
  fileSale?(credential: StallCredential, sale: CardSale): Promise<boolean>
  /**
   * The stall's CURRENT coupon validity, from its signed public merchant record (imani-wallet#312,
   * `stallValidity.ts`). Must never throw.
   */
  validityFor(stallPubkey: string): Promise<StallValidity>
  /**
   * Locked gift delivery (#410 G14). Absent (not configured), handle and email gifts are refused
   * before minting, exactly as before G14.
   */
  gifts?: GiftPorts
}

/**
 * How many passes may find the stall's merchant record unreadable before the debt is parked for a
 * person (imani-wallet#312).
 *
 * Counted in PASSES, and nothing backs a pass off: payment-adapter lists an OWED row again at once
 * (`findClaimable` has no retry-after), and the loop runs every `PURCHASE_INTERVAL_MS` (15 s by
 * default). So this is about an hour at the default cadence. It was 12, which is three minutes:
 * a gateway restart parked every paid card sale for an operator (review of #315).
 */
export const VALIDITY_MAX_ATTEMPTS = 240

/**
 * How long to wait for a token before giving up on this pass.
 *
 * Minting is asynchronous: `imani-woo` measured a voucher id back in ~250ms and
 * the token about 1.5s later, against a real gateway. Three seconds is a
 * CEILING rather than a target — past it the coupon is not lost, it is simply
 * collected on the next pass.
 *
 * Unlike `imani-woo`, nobody is waiting on a checkout response here, so this
 * could be longer. It is not, because a long wait holds a worker on one debt
 * while others queue behind it, and lateness costs less than a stall's whole
 * backlog stalling on one slow mint.
 */
const TOKEN_WAIT_MS = 3000
const TOKEN_POLL_MS = 400

/**
 * Work one Obligation as far as it will go.
 *
 * Never throws. Every failure is a returned Outcome, because a thrown error in
 * a loop over debts is how one bad row stops the rest from being paid.
 */
export async function discharge(
  baseUrl: string,
  obligation: Obligation,
  ports: Ports,
): Promise<Outcome> {
  const credential = await ports.credentialFor(obligation.stallPubkey)

  // A stall that never enrolled an issuer is the ORDINARY configuration, not a
  // failure. `imani-woo` is explicit that warning on every sale trains a
  // merchant to ignore the log. The debt stands and the stall issues by hand.
  if (credential === null) {
    return { kind: 'manual' }
  }

  // The credential can never be confirmed (imani-wallet#296: 410 EXPIRED). Minting would get a
  // 403 that reads as "burnt or replaced", and BLOCK a paid purchase on the wrong reason. Left
  // OWED instead, with the real reason: once the stall re-enrols, the next pass mints it.
  if (credential.unusable) {
    return { kind: 'owed', reason: credential.unusable, ambiguous: false }
  }

  // A guest (no buyer pubkey) would take delivery by Cashlink, which is not
  // wired (delivery.ts). Minting first strands a paid coupon, retried forever.
  // Checkout refuses guests now; this blocks any debt that predates that.
  if (obligation.recipient.kind === 'claim' && obligation.gift?.kind !== 'email') {
    return {
      kind: 'blocked',
      reason: 'guest purchase: Cashlink delivery is not wired yet; nothing minted, refund or deliver by hand',
    }
  }

  // #410: a handle or email gift must arrive LOCKED with a refund to the buyer (G7, §4c). Minting
  // it here would hand an unlocked voucher to the recipient (handle) or to nobody (email), and the
  // buyer could never get it back. Refused BEFORE minting, so nothing exists that a second pass
  // could double: payment-adapter only sells these once `purchase.gifting.kinds` enables them,
  // which waits for arming (see giftLock.ts).
  const giftKind = obligation.gift && obligation.gift.kind !== 'self' ? obligation.gift.kind : null
  // #410 code gifts (payment-adapter#314, plan option 1(a)): minted locked to the shop key S and
  // deposited at imani-checkout-codes, only when `PURCHASE_CODE_GIFTS=true` wired the code store.
  // Otherwise refused BEFORE minting: read as an email gift it would mint and mail a VOUCHER for a
  // code purchase.
  const isCode = obligation.gift?.delivery?.gift === 'code'
  if (isCode && !ports.gifts?.codes) {
    return { kind: 'attention', reason: 'code gift: this issuer does not mint checkout-code gifts (PURCHASE_CODE_GIFTS is off); nothing minted, refund or issue by hand' }
  }
  if (giftKind !== null && !ports.gifts) {
    return {
      kind: 'blocked',
      reason: `${giftKind} gift: locked gift delivery is not configured on this issuer; nothing minted`,
    }
  }
  // Everything that can refuse a gift without the stall's term is checked here, before minting.
  let lockPubkey: string | null = null
  let linkSecret: string | null = null
  const giftDelivery = obligation.gift?.delivery ?? null
  if (giftKind !== null) {
    if (!giftDelivery || giftDelivery.kind !== giftKind || !giftDelivery.refundPubkey) {
      return { kind: 'blocked', reason: `${giftKind} gift: the pinned delivery is missing or malformed; nothing minted` }
    }
    if (giftKind === 'handle') {
      if (obligation.recipient.kind !== 'pubkey') {
        return { kind: 'blocked', reason: 'handle gift with no pinned recipient key; nothing minted' }
      }
      lockPubkey = obligation.recipient.pubkey.toLowerCase()
    } else if (isCode) {
      // The link secret is unused for a code: the seal is never opened, only scrubbed after delivery.
      if (!giftDelivery.recipientEmail || !obligation.gift?.draftId || !giftDelivery.shopKey || !giftDelivery.shopUrl || !giftDelivery.codeExpiresAt) {
        return { kind: 'attention', reason: 'code gift: no recipient email, draft, shop key, shop url or code expiry pinned; nothing minted' }
      }
      // Checked BEFORE minting: the mail carries this url as plain text (each shop has its own host,
      // so it cannot be on the mailer's link allowlist), so only a clean https url is ever sent.
      if (cleanShopUrl(giftDelivery.shopUrl) === null) {
        return { kind: 'attention', reason: 'code gift: the pinned shop url is not a clean https url; nothing minted' }
      }
      lockPubkey = giftDelivery.shopKey.toLowerCase()
    } else {
      if (!giftDelivery.sealed || !giftDelivery.recipientEmail || !obligation.gift?.draftId) {
        return { kind: 'attention', reason: 'email gift: no sealed link secret, recipient email or draft (already scrubbed?); nothing minted' }
      }
      try {
        linkSecret = openSeal(ports.gifts!.sealSecretHex, giftDelivery.sealed, {
          stallPubkey: obligation.stallPubkey,
          amountMinor: obligation.faceValue,
          recipient: giftDelivery.recipientEmail,
        }).linkSecret
      } catch (error) {
        // Never the plaintext: SealRefused carries none.
        return { kind: 'blocked', reason: `email gift: ${error instanceof SealRefused ? error.message : 'the seal could not be opened'}; nothing minted` }
      }
      lockPubkey = getPublicKey(hexToBytes(linkSecret))
    }
  }

  // Every debt this service works is a CARD purchase, and its warrant is the
  // only place the stall can reconcile it against Stripe. A delegated warrant
  // with no `ref` would mint and then read as rail "unknown" (#267). Checkout
  // in payment mode always yields a payment_intent, so a missing one is an
  // upstream defect: refuse before minting and leave the debt for a person.
  // BLOCKED, not owed: retrying the same row cannot produce a reference.
  if (!obligation.processorReference) {
    return {
      kind: 'blocked',
      reason: 'card purchase has no processor reference (pi_…); refusing to mint an unreconcilable coupon',
    }
  }

  // The till refuses any coupon this service cannot warrant (#152), so a
  // credential without a live delegation from the stall must not mint at all.
  // BLOCKED rather than owed: retrying cannot help until the stall signs a new
  // delegation, which needs a person, and nothing was minted.
  //
  // The coupon's life is the stall's OWN term, read now from its signed record (#312). Unreadable
  // is not a reason to guess: the debt stays OWED and the next pass asks again, up to a bound.
  const validity = await ports.validityFor(obligation.stallPubkey)
  // Review of #315: "no signed record" at MINT time is treated like unreadable, not as the stall's
  // never-expires default. gc answers 200 with no events when its relay query fails and its cache
  // has no copy (CachingNostrGatewayDecorator swallows the relay error), and `/ready` already
  // refused a stall whose answer really is the default before anyone paid. So a paid sale that
  // reads "no record" is far likelier a gateway miss than a stall that deleted its record, and
  // parking it at once would send a paid buyer to an operator for a refund on a blip.
  const unknown =
    validity.kind === 'unreadable'
      ? validity.reason
      : validity.source === 'default'
        ? 'the gateway returned no signed merchant record for the stall'
        : null
  if (unknown !== null || validity.kind !== 'days') {
    const why = unknown ?? 'unreadable'
    if (obligation.attempts + 1 >= VALIDITY_MAX_ATTEMPTS) {
      return { kind: 'attention', reason: `validity_unreadable: ${why}` }
    }
    return { kind: 'owed', reason: `stall validity unknown: ${why}`, ambiguous: false }
  }
  const expiresInDays = validity.days
  const mintedAt = ports.now()

  // G14: the lock, from a DURABLE anchor so every retry asks for the same locktime (another
  // locktime is another body under the same warrant nonce, which gc refuses). Keyed on the PAYMENT,
  // like the idempotency key and the warrant nonce: two Stripe events for one payment intent (or a
  // reconciler re-drive) are one mint and must ask for one locktime.
  let giftLock: GiftLock | null = null
  if (isCode) {
    // x is pinned by payment-adapter (the same on every retry), so no anchor is needed: checked
    // against the store's window from NOW and the coupon's expiry, else nothing is minted.
    const lock = codeLockFor({
      shopKey: lockPubkey!,
      refundPubkey: giftDelivery!.refundPubkey,
      depositorPubkey: depositorOf(ports.gifts!.sealSecretHex),
      locktime: giftDelivery!.codeExpiresAt!,
      nowMs: mintedAt,
      couponExpiresAtMs: couponExpiresAtMs(mintedAt, expiresInDays),
    })
    if ('problem' in lock) {
      return { kind: 'attention', reason: `code gift cannot be locked (${lock.problem}); nothing minted, refund or issue by hand` }
    }
    giftLock = lock
  } else if (giftKind !== null) {
    let anchor: number
    try {
      anchor = await ports.gifts!.anchor(purchaseIdempotencyKey(obligation.processorReference!), mintedAt)
    } catch (error) {
      return { kind: 'owed', reason: `gift mint anchor unavailable: ${describe(error)}`, ambiguous: false }
    }
    const lock = giftLockFor({
      lockPubkey: lockPubkey!,
      refundPubkey: giftDelivery!.refundPubkey,
      mintedAtMs: anchor,
      nowMs: mintedAt,
      claimWindowDays: giftDelivery!.claimWindowDays,
      couponExpiresAtMs: couponExpiresAtMs(anchor, expiresInDays),
      testWindowSeconds: ports.gifts!.testWindowSeconds ?? null,
    })
    if ('problem' in lock) {
      return { kind: 'attention', reason: `${giftKind} gift cannot be locked (${lock.problem}); nothing minted, refund or issue by hand` }
    }
    giftLock = lock
  }
  const delegation = checkDelegation(credential, couponExpiresAtMs(mintedAt, expiresInDays))
  if (!delegation.ok) {
    // The readiness check refuses these before payment (#312); reaching here means the stall
    // changed its term between checkout and mint. A person decides: refund or issue by hand.
    if (delegation.code === 'never_expires') {
      return { kind: 'attention', reason: `validity_never_expires: ${delegation.reason}` }
    }
    if (delegation.code === 'outlives_delegation') {
      return { kind: 'attention', reason: `validity_outlives_delegation: ${delegation.reason}` }
    }
    return { kind: 'blocked', reason: delegation.reason }
  }

  const issuanceWarrant = delegatedWarrant({
    // The nonce derives from the PAYMENT, not the event (imani-wallet#274): any re-drive of one
    // pi_ is the same warrant use at gc, which replays the recorded voucher (gc#232).
    paymentIntent: obligation.processorReference,
    issuerId: credential.stallPubkey.toLowerCase(),
    saleTotalMinor: obligation.faceValue,
    faceDecimals: obligation.faceDecimals,
    unit: obligation.faceUnit,
    reference: obligation.processorReference ?? null,
    lockKeyHex: credential.lockKeyHex,
    delegation: delegation.event,
  })

  let coupon: IssuedCoupon
  try {
    coupon = await issueAsStall(baseUrl, credential, {
      faceValue: obligation.faceValue,
      faceUnit: obligation.faceUnit,
      faceDecimals: obligation.faceDecimals,
      memo: obligation.memo,
      expiresInDays,
      // The payment intent, so every attempt at this PAYMENT (a lapsed claim,
      // a second event, a reconciler re-drive) mints under one key
      // (imani-wallet#96, #274).
      idempotencyKey: purchaseIdempotencyKey(obligation.processorReference),
      // Signed as the stall's delegate, with the stall's own delegation inside,
      // so the till verifies it offline (#152). The processor reference rides
      // along inside the signed bytes for reconciliation.
      issuanceWarrant,
      ...(giftLock
        ? { linkLock: { recipientPubkey: giftLock.lockPubkey, refundPubkey: giftLock.refundPubkey, locktime: giftLock.locktime } }
        : {}),
    })
  } catch (error) {
    if (error instanceof IssuanceFailed && error.unrecorded) {
      return { kind: 'unrecorded', reason: error.message }
    }
    if (error instanceof IssuanceFailed && error.salesLimit) {
      // gc#317: a paid sale the stall's Free plan cannot cover. Retrying would leave a charged buyer
      // waiting forever with nobody looking; a person refunds or issues by hand once the stall upgrades.
      return { kind: 'attention', reason: `sales_limit_reached: ${error.message}; refund or issue by hand` }
    }
    if (error instanceof IssuanceFailed) {
      // A burnt credential will never mint. Retrying it forever would bury the
      // one case that needs a human in a log of identical failures.
      return error.retryable
        ? { kind: 'owed', reason: error.message, ambiguous: error.ambiguous }
        : { kind: 'blocked', reason: error.message }
    }
    return { kind: 'owed', reason: describe(error), ambiguous: true }
  }

  // From here a coupon EXISTS. Nothing below may report the debt as unminted,
  // because a second pass would mint a second coupon for one payment.

  // The sale goes into the stall's ledger as soon as the coupon exists, delivered
  // or not: an undelivered card coupon is still the stall's sale (#275, gap D).
  // Tried once inline; one that does not land is returned as `pendingSale`, and the
  // delivery outbox owns its retries (imani-wallet#274, U8).
  let pendingSale: CardSale | null = null
  if (ports.fileSale) {
    const at = ports.now()
    const sale: CardSale = {
      voucherId: coupon.voucherId,
      faceValue: obligation.faceValue,
      faceUnit: obligation.faceUnit,
      faceDecimals: obligation.faceDecimals,
      memo: obligation.memo,
      // Never for a gifting-site gift (G9): the stall learns nothing of the buyer or the
      // recipient, and a handle recipient's key would name them on the stall's vouchers list.
      recipientPubkey: giftKind === null && obligation.recipient.kind === 'pubkey' ? obligation.recipient.pubkey : undefined,
      at,
      // The gateway counts `expires_in_days` from its own mint instant, so this is
      // the coupon's expiry to within the mint's latency. Without it the merchant
      // record reads "No expiry" for a coupon that expires (S1 showed the date).
      // The same `expiresInDays` the mint was sent, so the two cannot disagree (#312).
      expiresAt: expiresInDays === 0 ? undefined : Math.floor(at / 1000) + expiresInDays * 86_400,
      issuanceWarrant,
    }
    // try/await, not `.catch`: a port that throws synchronously must not escape
    // either, because the coupon already exists (review of #278).
    let filed = false
    try {
      filed = await ports.fileSale(credential, sale)
    } catch {
      filed = false
    }
    if (!filed) pendingSale = sale
  }
  const minted: Minted = { issuerId: coupon.issuerId, pendingSale }

  let token = coupon.token
  if (token === '') {
    token = await waitForToken(credential, coupon.voucherId, ports)
  }

  if (token === '') {
    return {
      kind: 'undelivered',
      voucherId: coupon.voucherId,
      reason: 'the mint has not produced a token yet',
      ...minted,
    }
  }

  if (giftLock !== null) {
    // G17 (C): the voucher's own expiry, which a gift taken back unclaimed keeps (the gateway counts
    // `expires_in_days` from its mint instant, as the sale record above does).
    const spendByMs = couponExpiresAtMs(mintedAt, expiresInDays)
    if (isCode) return deliverCodeGift(obligation, coupon.voucherId, token, giftLock, ports, minted)
    return deliverGift(baseUrl, credential, obligation, coupon.voucherId, token, giftLock, linkSecret, ports, minted, spendByMs)
  }

  try {
    const delivered = await deliver(
      baseUrl,
      credential,
      obligation.recipient,
      token,
      obligation.paymentRequestId,
      coupon.voucherId,
      fetch,
      () => ports.now(),
    )
    return {
      kind: 'discharged',
      voucherId: coupon.voucherId,
      eventId: delivered.eventId,
      ...minted,
    }
  } catch (error) {
    return {
      kind: 'undelivered',
      voucherId: coupon.voucherId,
      reason: error instanceof Error ? error.message : describe(error),
      ...(error instanceof DeliveredUnconfirmed || error instanceof DeliveryRefused ? { delivered: true as const } : {}),
      ...(error instanceof DeliveryRefused ? { refused: true as const } : {}),
      ...minted,
    }
  }
}

/**
 * Deliver a minted locked gift (#410 G14): verify the lock, reach the recipient, hand the buyer
 * their copy, and only then report it discharged.
 */
async function deliverGift(
  baseUrl: string,
  credential: StallCredential,
  obligation: Obligation,
  voucherId: string,
  token: string,
  lock: GiftLock,
  linkSecret: string | null,
  ports: Ports,
  minted: Minted,
  spendByMs: number | null,
): Promise<Outcome> {
  const gifts = ports.gifts!
  const delivery = obligation.gift!.delivery!
  const undelivered = (reason: string, park = false): Outcome => ({ kind: 'gift_undelivered', voucherId, reason, park, ...minted })

  // Never hand anyone a token that is not exactly the lock asked for: a plain or mis-locked coupon
  // would be the recipient's (or nobody's) money with no way back for the buyer.
  const wrong = verifyLockedGift(token, lock)
  if (wrong !== null) return undelivered(`minted gift is not locked as asked: ${wrong}; NOT delivered`, true)

  const tooMany = obligation.attempts + 1 >= GIFT_MAX_ATTEMPTS
  const failed = (reason: string, permanent: boolean) => undelivered(reason, permanent || tooMany)

  let eventId: string | undefined
  if (obligation.gift!.kind === 'handle') {
    try {
      const sent = await deliver(baseUrl, credential, obligation.recipient, token, obligation.paymentRequestId, voucherId, fetch, () => ports.now())
      eventId = sent.eventId
    } catch (error) {
      // DeliveredUnconfirmed: the DM went out, unrecorded; the retry re-sends (the wallet dedupes).
      return failed(describe(error), error instanceof DeliveryRefused)
    }
  } else {
    const ell = hexToBytes(linkSecret!)
    const wrapped = await publishLinkWrap(gifts, ell, token)
    if (!wrapped.ok) return failed(wrapped.reason, wrapped.permanent)
    const stall = (await gifts.stallName(obligation.stallPubkey)) ?? 'a local stall'
    const claimUrl = claimLink(gifts.walletOrigin, linkSecret!, lock.locktime)
    if (claimUrl === null) return failed('the claim link could not be built from the wallet origin', true)
    const mailed = await sendClaimEmail(gifts, {
      to: delivery.recipientEmail!,
      draftKey: obligation.gift!.draftId!,
      fields: {
        ...(delivery.from ? { from: delivery.from } : {}),
        stall,
        amount: formatAmount(obligation.faceValue, obligation.faceDecimals, obligation.faceUnit),
        claimBy: new Date(lock.locktime * 1000).toUTCString().slice(0, 16),
        claimUrl,
        ...(delivery.message ? { message: delivery.message } : {}),
      },
    })
    if (!mailed.ok) return failed(mailed.reason, mailed.permanent)
  }

  // Contract §3: the buyer's copy, so they can take it back after x. Before the scrub, so a retry
  // after a failure here can still open the seal and re-confirm the (idempotent) email steps.
  const handed = await handBuyerTheGift(gifts, {
    refundPubkey: lock.refundPubkey,
    token,
    // Shown to the buyer: a name, never a key.
    stall: (await gifts.stallName(obligation.stallPubkey)) ?? 'a local stall',
    to: delivery.recipientEmail ?? null,
    claimBy: lock.locktime,
  })
  if (!handed.ok) return failed(handed.reason, handed.permanent)

  if (obligation.gift!.kind === 'email') {
    let scrubbed = false
    try {
      scrubbed = await gifts.scrubSeal(obligation.id)
    } catch {
      scrubbed = false
    }
    if (!scrubbed) {
      // Delivered; the seal outlives the email until payment-adapter's own scrub. Loud, no secret.
      console.warn(JSON.stringify({ event: 'gift_seal_not_scrubbed', event_id: obligation.id }))
    }
  }
  await trackGift(gifts, obligation, token, lock, spendByMs)
  return { kind: 'discharged', voucherId, ...(eventId ? { eventId } : {}), ...minted }
}

/**
 * Deliver a minted code gift (#410, plan steps 2 and 3): verify the part shape, deposit it as a
 * code, mail the recipient the code, hand the buyer their copy, scrub the seal, track it.
 * Every step is idempotent, so a retry after a crash anywhere re-runs them all safely.
 */
async function deliverCodeGift(
  obligation: Obligation,
  voucherId: string,
  token: string,
  lock: GiftLock,
  ports: Ports,
  minted: Minted,
): Promise<Outcome> {
  const gifts = ports.gifts!
  const codes = gifts.codes!
  const delivery = obligation.gift!.delivery!
  const draftId = obligation.gift!.draftId!
  const undelivered = (reason: string, park = false): Outcome => ({ kind: 'gift_undelivered', voucherId, reason, park, ...minted })

  // Never deposit a part that is not exactly contract §2's shape for S, R and x.
  const wrong = verifyCodePart(token, lock)
  if (wrong !== null) return undelivered(`minted code part is not locked as asked: ${wrong}; NOT deposited`, true)

  const tooMany = obligation.attempts + 1 >= GIFT_MAX_ATTEMPTS
  const failed = (reason: string, permanent: boolean) => undelivered(reason, permanent || tooMany)

  let body
  try {
    body = depositBody({ draftId, stallPubkey: obligation.stallPubkey, lock, unit: obligation.faceUnit, tokens: [token] })
  } catch {
    return undelivered('the minted code part could not be read; NOT deposited', true)
  }
  const deposited = await depositCode(codes, hexToBytes(gifts.sealSecretHex), body)
  if (!deposited.ok) return failed(deposited.reason, deposited.permanent)

  const stall = (await gifts.stallName(obligation.stallPubkey)) ?? 'a local stall'
  const shopLink = cleanShopUrl(delivery.shopUrl)
  if (shopLink === null) return failed('the pinned shop url is not a clean https url', true)
  const shop = shopLink.host
  const amount = formatAmount(deposited.amount, obligation.faceDecimals, obligation.faceUnit)
  const expiresOn = new Date(lock.locktime * 1000).toUTCString().slice(0, 16)
  const mailed = await sendCodeEmail(gifts, {
    to: delivery.recipientEmail!,
    idempotencyKey: `${draftId}:code-mail`,
    fields: {
      ...(delivery.from ? { from: delivery.from } : {}),
      stall,
      shop,
      amount,
      code: displayCode(deposited.code),
      shopUrl: shopLink.href,
      expiresOn,
      balanceUrl: balanceUrl(codes.publicBaseUrl, deposited.code),
      ...(delivery.message ? { message: delivery.message } : {}),
    },
  })
  if (!mailed.ok) return failed(mailed.reason, mailed.permanent)

  // The buyer's copy, a wrap to R, for the return page: after x it settles what is left.
  const handed = await handBuyerTheGift(gifts, {
    refundPubkey: lock.refundPubkey,
    token,
    stall,
    to: delivery.recipientEmail ?? null,
    claimBy: lock.locktime,
    gift: 'code',
  })
  if (!handed.ok) return failed(handed.reason, handed.permanent)

  let scrubbed = false
  try {
    scrubbed = await gifts.scrubSeal(obligation.id)
  } catch {
    scrubbed = false
  }
  if (!scrubbed) console.warn(JSON.stringify({ event: 'gift_seal_not_scrubbed', event_id: obligation.id }))

  await trackGift(gifts, obligation, token, lock, null, { code: deposited.code, amountMinor: deposited.amount, decimals: obligation.faceDecimals, unit: obligation.faceUnit })
  return { kind: 'discharged', voucherId, ...minted }
}

/**
 * G15 §4.3: remember the delivered gift so the buyer hears when it is claimed or expires. Best
 * effort: the gift is delivered, and failing the discharge here would only re-deliver it. Logged
 * with no address, draft id or amount.
 */
async function trackGift(
  gifts: GiftPorts,
  obligation: Obligation,
  token: string,
  lock: GiftLock,
  spendByMs: number | null,
  code?: { code: string; amountMinor: number; decimals: number; unit: string },
): Promise<void> {
  if (!gifts.track) return
  const delivery = obligation.gift!.delivery!
  const draftId = obligation.gift!.draftId
  const kind = code ? 'code' : (obligation.gift!.kind as 'handle' | 'email')
  if (!draftId || !delivery.buyerEmail) {
    console.warn(JSON.stringify({ event: 'gift_not_tracked', kind, reason: draftId ? 'no buyer email' : 'no draft' }))
    return
  }
  const recipientDisplay =
    kind !== 'handle'
      ? delivery.recipientEmail ?? 'the recipient'
      : delivery.recipientHandle
        ? delivery.recipientHandle.includes('@') ? delivery.recipientHandle : `@${delivery.recipientHandle}`
        : 'the recipient'
  // Guest: no signed-in buyer, or a refund key that is not the buyer's wallet key (it is R).
  const guest = !delivery.buyerPubkey || delivery.buyerPubkey.toLowerCase() !== lock.refundPubkey.toLowerCase()
  try {
    const mintUrl = tokenMintUrl(token)
    await gifts.track(
      {
        draftId,
        kind,
        token,
        claimBy: lock.locktime * 1000,
        buyerEmail: delivery.buyerEmail,
        recipientDisplay,
        stall: (await gifts.stallName(obligation.stallPubkey)) ?? 'a local stall',
        amount: formatAmount(obligation.faceValue, obligation.faceDecimals, obligation.faceUnit),
        guest,
        returnMailDate: guest && delivery.draftCreatedAt ? displayDate(delivery.draftCreatedAt) : null,
        spendBy: spendByMs,
        ...(code ? { code } : {}),
      },
      mintUrl,
    )
  } catch (error) {
    console.warn(JSON.stringify({ event: 'gift_not_tracked', kind, reason: error instanceof Error ? error.name : 'error' }))
  }
}

function claimLink(walletOrigin: string, linkSecretHex: string, x: number): string | null {
  return formatGiftLink(walletOrigin, hexToBytes(linkSecretHex), x)
}

function formatAmount(minor: number, decimals: number, unit: string): string {
  const major = (minor / 10 ** decimals).toFixed(decimals)
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: unit }).format(Number(major))
  } catch {
    return `${major} ${unit}`
  }
}

/** Poll briefly for a token the mint had not finished producing. */
async function waitForToken(
  credential: StallCredential,
  voucherId: string,
  ports: Ports,
): Promise<string> {
  const deadline = ports.now() + TOKEN_WAIT_MS
  while (ports.now() < deadline) {
    await ports.sleep(TOKEN_POLL_MS)
    try {
      const token = await ports.tokenFor(credential, voucherId)
      if (token !== '') return token
    } catch {
      // A failed poll is not a failed mint. Keep trying until the ceiling.
    }
  }
  return ''
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
