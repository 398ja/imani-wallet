# A gift to an email is a Cashlink whose refund key the buyer holds

Status: accepted (owner decisions G3, G4, G10 on #410, 2026-10-28)

A voucher bought on the gifting page for an email address is delivered as a
**Cashlink** (#295): locked to a link key `L`, with `refund = [R]` and
`locktime = x`, and a pre-signed refund at the relay. The question #410 turned
on is who holds `R` when the buyer has no wallet.

**`R` is always the buyer's.** A signed-in buyer's `R` is their wallet key
(option A). A guest's `R` is made in the guest's browser at review and handed
back to them as a **return link** (option D). Imani never holds it.

## Rejected

- **The server holds `R`** (option B). Custody of the coupons, and one server
  key that could take back every unclaimed gift.
- **The refund goes to the stall** (option C). The guest paid and loses the
  value when nobody claims.
- **No email gifts for guests** (option E). Only if D proved too much.

## The one bounded exception (G4)

Delivery must run from the Stripe webhook even if the buyer's tab is gone, so
the link secret `ℓ` (the recipient's claim key, never `R`) is **sealed** in the
browser to the Purchase Issuer's key (NIP-44 v2 from a one-off key), bound to
the stall, amount and recipient address. The issuer opens it only to arm the
Cashlink and send the claim email, and the debt's copy is scrubbed
(`/purchases/{id}/scrub`) once the email is accepted. It is never logged, never
in Stripe metadata, and never returned by the draft API.

## Consequences

- Arming from the server needs a lock route the issuer may call without `R`
  (the plan-then-sign API of #366). Until it exists, payment-adapter sells only
  "to myself" (`purchase.gifting.kinds=self`), and purchase-issuer blocks a
  handle or email gift **before minting** rather than delivering it unlocked.
- Handle gifts (G7) use the same lock with the recipient's pinned pubkey in
  place of `L`, and the same window `x`: 30 days, capped by the voucher expiry
  minus 24 h (G11).
- The buyer never sees the claim link (G8). The return page and the return link
  show `R`, which is theirs.
