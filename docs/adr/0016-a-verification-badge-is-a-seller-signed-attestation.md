# A verification badge is a seller-signed public attestation

A business on a paid plan wears a verification badge on its avatar (#418): bronze for Essentials,
silver for Pro, gold for the partnership tier or a hand grant that names it. The badge lasts exactly
as long as the subscription, with no grace window. A stall on Starter, or with no plan, wears none.
The orange "merchant" badge, which any key with a stall record wore, is gone.

## The problem

A licence (ADR 0007) is delivered to its stall privately, by NIP-17 DM. Only the stall's own wallet
knows its plan. Every other viewer, a customer looking at a stall on a coupon, a toast, the public
profile or the till, has no way to learn it, so the badge needs a **public** statement of the plan
that a viewer can check without trusting the stall.

## The decision

The subscription service publishes one addressable event per stall:

- kind 30078, `d = imani:verification:<stall pubkey>`, signed by the **licence seller key** (the
  same key that signs licence warrants and the catalog, `VITE_LICENCE_SELLER_PUBKEY`);
- content `{"type":"imani-verification/1","stall":"<hex>","badges":[{"badge","valid_from","valid_to"}]}`,
  one window per licence minted and not revoked, computed from the sales ledger;
- republished on every change: a payment, a renewal, a hand grant, a revocation, a resend. The
  newest event is the whole answer, so a revocation is the list without that subscription.

A viewer accepts it only if the event's signature verifies **and** its author is the pinned seller,
and its `stall` and `d` name the avatar's key. A build with no seller pinned shows no badges at all.
The stall's own wallet also reads the licences it holds, verified now (not carried by grace), so its
own badge appears the moment a plan arrives.

Which badge a tier earns is the catalog's (`badge` per tier, catalog v4), so re-mapping a tier needs
no app release and no re-issue. A hand grant may sign its own `badge` into the licence and the
ledger (#418 Q3).

## Options considered

- **Publish the licence itself.** Rejected: a licence is a voucher, and a public copy of it is a
  public copy of a credential. It also carries the price paid.
- **The stall publishes a proof of its licence.** Rejected: it needs the stall's wallet to be open
  to publish, renew and withdraw, and any proof a stall can produce from its licence reveals
  licence fields beyond the badge.
- **A lookup API on the subscription service.** Rejected: every avatar render would be a request
  to one service, and it tells that service who is looking at whom.

## What it puts on the relay, on purpose

That a stall is on a paid plan, which badge, and between which dates. Nothing about money: no price,
no Stripe id, no subscription id. ADR 0007 avoided server-side per-stall state for **granting**;
this record grants nothing, it only lets others see what the stall paid to show.

## Consequences

- A forged badge needs the seller key. A stall cannot award itself one.
- A lost publish is repaired by the next change or by "Check for my licence" (resend).
- The badge on a screen left open drops at `valid_to`: the wallet schedules the next window edge.
- Gold is available today through a hand grant. The partnership tier itself is deferred (#418 Q2).
