# Handoff — buying a coupon with a card

Written 8 September 2026 for `/grill-with-docs` **in this repo**. The strategy that produced it
lives elsewhere; this file carries only what the design needs.

## The brief

1. A merchant configures **Stripe** in Settings — a new section there.
2. A customer opens a **merchant profile page** showing everything relevant about that merchant,
   with a button that starts a card payment.
3. The customer pays **directly to the merchant** and receives the coupon in their wallet.
4. **Ideally atomic.**

Three further surfaces to card in the same pass, because they share a backend (see *One core, four
surfaces*): **hosted purchase page**, **embeddable widget**, **in-wallet top-up**.

## Settled before grilling — do not re-derive

> **Corrected 8 September 2026 after grilling.** Three claims below were written
> without reading `payment-adapter` and `imani-merchant`, and two of them were
> wrong. Corrections are marked. See `imani-wallet/docs/adr/0009`, `0010`, and
> `payment-adapter/docs/adr/0001`.

- **Stripe Connect, direct charges.** The connected account is always merchant of
  record; funds never touch an Imani balance; disputes and negative balances land on the merchant,
  and Stripe takes negative-balance liability. Destination charges would make Imani the platform of
  record and holder of funds — that breaks the no-float position that keeps Imani outside the FCA
  safeguarding perimeter. This is not a preference, it is the reason the model works.

  **CORRECTION — the code does not do this yet.** `StripeSdkCheckoutClient` sets
  no `Stripe-Account` and no `application_fee_amount`, so every session it
  creates today charges the **platform**. The no-float position is a target, not
  the status quo, and correcting it is its own piece of work that must land
  first.

  **CORRECTION — Standard was wrong, and it is Express.**
  `StripeSdkConnectClient` already creates `Type.EXPRESS`. The account type was
  never what delivered the no-float property; direct charges were. Express
  stands, because Express accounts cannot be converted in place and
  re-onboarding every connected stall to win a support-burden argument is a bad
  trade. Consequence: Imani is first-line support, and the reserve disclosure
  matters more.
- **Google Play permits this.** Vouchers and gift cards are carved out of Play Billing — no 15–30%
  cut — because a coupon is redeemed for real goods at a real merchant and can never become bitcoin.
  Verify current wording before shipping; Play policy is moving under antitrust litigation.
- **Delegated issuance already exists and is proven.** `imani-woo` ADR 0008 records a Shop minting
  as the Stall autonomously, holding a burnable scoped credential, nobody in the loop. Whatever the
  front end, the back end is that. Read that ADR before designing a second mechanism.
- **PayPal is later, not never.** `payee.merchant_id` + `platform_fees` gives the same no-float
  shape, but partner enablement is **not self-serve** and has lead time. Start the application in
  parallel; build on Stripe.

## What already exists that this must fit

| Surface | Why it matters |
| --- | --- |
| `src/pages/MerchantPage.tsx`, `MerchantsPage.tsx` | A shopper already views a merchant and their coupons. Is the profile page new, or is this page grown? Decide before building a second one. |
| `src/lib/branding.ts` | Merchant name, picture and banner already come from the Nostr kind-0 event. The profile page's content may largely exist. |
| `src/pages/SettingsPage.tsx`, `SubscriptionPage.tsx` | Where the Stripe section slots in, and the precedent for how a paid capability is presented. |
| `src/lib/arrivalToast.ts` | The "on its way" pattern already covers the gap between *sent* and *settled*. It is probably the answer to the atomicity UX. |
| `src/lib/drive.ts` | Key escrow has landed, so a first-time buyer's onboarding is no longer the cliff it was. |
| Never-expiring coupons | Shipped and now the default. A coupon bought as a gift will not lapse. |

## The hard part: what "atomic" can actually mean

> **Settled.** See `imani-wallet/docs/adr/0010`. Paid before issued; an
> Obligation recorded atomically with payment confirmation and discharged only
> by confirmed issuance; visible to both sides with the action on the stall's.
> Delayed capture was considered and rejected — a capture failing after a mint
> recreates issued-not-paid, the one failure that must be impossible.

There is no distributed transaction across Stripe and the mint. Two writes, two systems, and a
window between them. The grilling needs to convert "ideally atomic" into a guarantee that is
implementable and worth having.

The shape that survives contact — and `imani-woo` already reached it, in ADR 0009 *"fulfilment is
confirmed, not asserted"* — is: **an Obligation recorded atomically with payment confirmation, then
discharged by autonomous issuance.** The customer's guarantee is atomic; the two writes are not.

Two failure modes, and they are not symmetrical:

- **Paid, not issued.** The merchant owes a coupon. Must be recoverable, must be visible to both
  sides, and must not depend on anyone noticing.
- **Issued, not paid.** Value given away. Must be impossible by construction, not by diligence.

Questions to settle: does the coupon mint on `payment_intent.succeeded` or on the webhook only?
What happens if the webhook never arrives? Is the Obligation visible to the customer, the merchant,
or both? Does the existing "on its way" toast cover the wait, or does a card purchase need something
firmer than a coupon handed over a counter?

**Reuse `imani-woo`'s word.** It says *Obligation*. A second name for the same idea across two repos
is the kind of drift `/domain-modeling` exists to stop.

## One core, four surfaces

Most of the "alternatives" are the same build wearing different clothes. Establish the shared core
first, then card the surfaces against it.

| Surface | Extra work beyond the core | Serves |
| --- | --- | --- |
| **Merchant profile page (in app)** | The page itself | A shopper already in the wallet |
| **Hosted purchase page** | A public web route, no app required | A merchant with **no website at all** — link in a bio, a QR on the stall sign, an email footer |
| **Embeddable widget** | An iframe wrapper on the hosted page | Squarespace, Wix, Shopify, static sites — every platform that would never admit Imani as a payment method but will happily render an embed |
| **In-wallet top-up** | An entry point from held coupons | The shopper who already holds this merchant's coupons and wants more. No discovery needed, so no marketplace cold start. |

Worth testing early: **Stripe Payment Links plus the embeddable Buy Button** may deliver the hosted
page *and* the widget with almost no bespoke front end — a custom field for the buyer's handle, and a
webhook into the issuance that already exists. If that holds, three surfaces collapse into a webhook
handler and a settings screen. That is a `/prototype` question, not a paper one.

## Open — grill these

> **Resolved 8 September 2026.** Answers below; the reasoning is in the ADRs.

1. **Where does the Stripe secret key live?** **Answered by fact, not by
   decision.** It already lives in `payment-adapter`, which owns the Stripe API
   calls, webhooks and account lifecycle; `imani-merchant` holds a mirror. No
   new service holds it and `wallet-api` needs no exception, so ADR 0001 and
   0002 stand untouched.
2. **Standard or Express Connect accounts?** **Express**, already shipped. See
   the correction above.
3. **Is the merchant profile page new, or is `MerchantPage` grown?** Still open.
   Deferred deliberately: it is a surface question and the payment path is
   unproven.
4. **How does a first-time buyer receive the coupon?** Still open. The
   cashback claim path (`/c/{ref}`) is the candidate, and there is a known gap —
   a claim URL opened by a freshly installed wallet is dropped by
   `PublicRoutes` (`src/App.tsx:483-489`), losing the ref and the key.
5. **What does the merchant see?** A **Purchase** is now a distinct term, since
   `packages/reports/stats.ts` derives everything from the stall's own wallet
   rows via `isOwnRedemption`, and a card sale produces no such row. How it is
   surfaced is still open.
6. **Refunds.** `imani-woo` ADR 0004 holds: the record is Imani's, performing
   the refund is the stall's. Under direct charges the stall holds the funds, so
   this follows rather than needing re-deciding.
7. **Currency.** `imani-woo` ADR 0005's rule holds. A stall has one
   `issuanceCurrency` (`src/lib/merchant.ts:46`); refuse Stripe setup when the
   connected account's currency differs, at setup and not at checkout, and
   re-check when either changes.
8. **Does buying count against anything?** **Yes.** The Purchase Issuer is a
   Terminal, so it consumes a terminal slot and card sales sit behind the paid
   tier of ADR 0007.

## One disclosure the merchant pitch must carry

With direct charges the merchant is merchant of record, so **disputes and any rolling reserve land on
them.** Stripe treats stored value and future delivery as reserve triggers — typically 5–15% held
30–180 days on a high-risk classification. Good for Imani's risk position; a real thing to tell a
merchant, because "get paid upfront" is the entire pitch and a reserve claws part of it back.
