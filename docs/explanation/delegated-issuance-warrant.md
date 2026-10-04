# The delegated issuance warrant

A card purchase is paid while the stall is asleep, so the stall cannot sign the
coupon's warrant itself. The `delegated` form lets it sign once, ahead of time,
and have the purchase issuer sign each sale under that.

## What is signed

1. **The stall's delegation.** A kind-30078 Nostr event signed with the stall's
   own key, with exactly one of each tag:
   - `d` = `imani:issuer-delegation`. Any other app-data record the stall signs
     is not a delegation, even if it carries the other tags.
   - `p` = the purchase issuer's lock key for that stall.
   - `scope` = `coupon:issue`.
   - `expiration` = a NIP-40 expiry, in seconds.
2. **The delegate's signature** over `delegatedSaleDigest`. That is SHA-256 of
   issuer, sale total, decimals, unit, nonce, and the processor reference (`ref`,
   or empty), joined by U+001F. The reference is signed, so the Stripe payment a
   stall reconciles against cannot be edited after the fact.

The whole event travels inside the warrant, and the warrant sits inside the
voucher's signed bytes. The till verifies both signatures offline
(`src/lib/issuerDelegation.ts`, `src/lib/issuanceWarrant.ts`).

## When the delegation must be in force

- **At the till:** unexpired as of the till's clock. The voucher carries no
  issue time signed by the mint or the issuer (cashu-voucher's secret has
  none), so the till cannot judge the delegation at the moment of sale.
- **In the stall's own ledger** (`issuedVoucher`, `reconcileIssuances`): at
  the time the sale was recorded, `created_at <= issued_at < expiration`. A
  past card sale stays "authorised" after its delegation lapses.
- **At the purchase issuer, before minting:** the delegation must outlive the
  coupon by 7 days (`DELEGATION_SKEW_MARGIN_MS`), to cover a till clock
  running ahead and the gateway stamping expiry slightly late. With 365-day
  coupons, delegations must therefore run at least 372 days.

Short rolling delegations (30 days was the review's suggestion) need a signed
issue time on the voucher first. Until then, a 30-day delegation would make
every card coupon die at the till after 30 days. That follow-up is tracked
in cashu-voucher.

## Replay

The till checks a warrant as a ceiling and remembers nothing. A delegated
warrant could therefore be copied off a sold coupon onto new coupons, by
anyone able to mint as the stall. The stronger fix would bind the delegate's
signature to one coupon, but the voucher id is chosen inside gateway-customer
after the warrant is signed, so purchase-issuer cannot sign over it.
gateway-customer therefore spends each delegated warrant's `(issuer, nonce)`
on voucher create, as the portal does for Sell. A copied warrant gets
`409 WARRANT_ALREADY_USED`, while an identical retry of one purchase (same
Idempotency-Key, same body) passes.

## Operating it

Attach a stall's signed delegation to its credential with:

    npx tsx services/purchase-issuer/attachDelegation.ts <stall-pubkey> <event.json>

It refuses a delegation the till would refuse, or one that would not outlive
a coupon minted today by the margin.
