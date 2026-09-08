# Context Map

Imani is several repos and one domain. The decisions that shape any one of them
routinely live in another, and until this file existed nothing said so: the
wallet's card-purchase design rests on four `imani-woo` ADRs that a reader of
`imani-wallet` alone would never know to look for.

The rule this map exists to enforce: **one decision, recorded once, cited from
wherever it binds.** Copying a decision into a second repo so that repo "stands
alone" is how two copies come to disagree.

## Contexts

- **[Wallet](./CONTEXT.md)** — `imani-wallet`. The customer's browser wallet and
  the stall's own surface. Holds the glossary the whole domain speaks: Coupon,
  Stall, Terminal, Takings, Purchase, Obligation.
- **Woo** — `imani-woo`. A WooCommerce plugin selling coupons online. Reached
  the delegated-issuance and fulfilment problems first, so its ADRs are load
  bearing well outside it.
- **Payment adapter** — `payment-adapter`. Owns every Stripe API call, the
  webhooks, and Connect account lifecycle. The only holder of the platform key.
- **Merchant** — `imani-merchant`. Onboarding and settings. Mirrors Stripe
  state; does not own it.
- **Cashback claim** — `imani-cashback-claim`. Parks a bearer token under a
  single-use claim handle and serves it to a wallet.
- **Gateway (customer)** — `imani-gateway-customer`. Mints coupons and verifies
  terminal credentials.

## Relationships

- **Payment adapter → Wallet.** A paid purchase is a fact about money; issuing a
  coupon is a separate consequence carried over a seam. Issuance never lives in
  the payments service, which must not acquire custody of Nostr issuing keys.
  See `payment-adapter/docs/adr/0001`.
- **Merchant → Payment adapter.** Merchant holds a *mirror* of Stripe state,
  synced by webhooks. A disagreement is mirror staleness, not a Stripe fact.
- **Wallet → Gateway.** The wallet API plans and the caller signs; the gateway
  derives an issuer from a terminal credential it looks up itself. See
  `imani-wallet/docs/adr/0001`, `0002`, and `0009`.
- **Cashback claim → Wallet.** The claim service parks a bearer token and the
  **wallet** redeems it. The claim page hands over and never spends. See
  `imani-cashback-claim/docs/adr/0001`.
- **Woo → Wallet.** Not a runtime dependency at all, and the most important edge
  on this map: a source of settled decisions.

## Decisions that bind more than one context

| Decision | Recorded in | Also binds |
| --- | --- | --- |
| The Shop issues for itself, on a burnable per-stall credential | `imani-woo` ADR 0008 | Wallet ADR 0009 |
| Fulfilment is confirmed, not asserted | `imani-woo` ADR 0009 | Wallet ADR 0010 |
| The plugin records a refund, it does not perform one | `imani-woo` ADR 0004 | Any card purchase refund |
| Store and coupon currency must match | `imani-woo` ADR 0005 | Stripe setup checks |
| The caller holds the key, and the coupons | `imani-wallet` ADR 0001 | Every service that would hold either |
| Coupon purchases are direct charges | `payment-adapter` ADR 0001 | The whole no-float position |

## Vocabulary across the boundary

**Stall** is the domain word and everything customer-facing says it. **Merchant**
survives service-side (`imani-merchant`, `merchantPubkey`, `MerchantStripeAccount`)
because Stripe's own vocabulary is merchant-shaped. Same concept, foreign name,
and it must not cross back into customer-facing text. `imani-woo` adds **Shop**
for the website, distinct from the Stall that honours the coupon.
