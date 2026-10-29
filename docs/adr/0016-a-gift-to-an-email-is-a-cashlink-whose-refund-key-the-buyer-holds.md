# A gift to an email is a Cashlink whose refund key the buyer holds

Status: accepted (owner decisions G3, G4, G10 on #410, 2026-10-28; G14, G15, 2026-10-29)

A voucher bought on the gifting page for an email address is delivered as a
**Cashlink** (#295): locked to a link key `L`, with `refund = [R]` and
`locktime = x`. The question #410 turned on is who holds `R` when the buyer has
no wallet.

**`R` is always the buyer's.** A signed-in buyer's `R` is their wallet key
(option A). A guest's `R` is made in the guest's browser at review and handed
back to them as a **return link** (option D), which is also emailed to them
(G15, below). Imani never holds it.

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
the stall, amount and recipient address. The issuer opens it only to mint the
locked voucher and send the claim email, and the debt's copy is scrubbed
(`/purchases/{id}/scrub`) once the email is accepted. It is never logged, never
in Stripe metadata, and never returned by the draft API.

## Minted locked, and no refund at the relay (G14)

A wallet-sent Cashlink comes back on its own: the sender signs, with `R`, a
swap of the locked proof into its own blinded outputs, and leaves it at the
refund relay to post after `x`. That swap covers the minted proof, so it can
only be signed after minting. For a gifting-site gift only the Purchase Issuer
is there at minting, and it must not hold `R`. So nobody can pre-sign it.

**So the voucher is minted already locked, and the buyer takes it back.** The
Purchase Issuer asks gateway-customer to issue it as
`P2PK_VOUCHER(data = L, refund = [R], locktime = x, sigflag = SIG_ALL, max_sats)`,
the same shape the `/cashlink/lock` route signs and checked by the same rules.
Nothing is burnt or re-locked, and nothing is deposited at the relay. After
`x`, a signed-in buyer's wallet takes it back on its next run, as it does an
unarmed link today, and a guest takes it back from the return link. Until the
buyer does, a late claim by the recipient still succeeds.

Rejected: sealing `R` to the issuer as well, so the issuer can sign the refund
and then delete `R` (that stretches G4 to the buyer's own key); and a hybrid in
which only a signed-in buyer's wallet arms the refund later (two behaviours
for one product).

## The return link is emailed to the guest (G15)

A return link the guest must copy at review is lost the moment they close the
tab, and the gift with it. So the buyer's email is required, and at **Pay** the
gifting page sends the return link (`<wallet>/gift-return#r=<R>`) to
payment-adapter, which emails it to the buyer (`gift-return-link`, through
imani-mailer) **before** Stripe Checkout starts. A link that is not accepted by
the mailer is a 503 and nothing is charged.

This is a second bounded exception, of a different kind from G4: `R` passes
through Imani's servers **once, in transit**, so that it can reach the buyer's
own inbox. Bounded as follows:

- payment-adapter checks that the link is the configured wallet origin's
  `/gift-return#r=` and that `R` is the private key of the draft's refund
  pubkey, then hands it to the mailer. It stores nothing of it (not on the
  draft, not in Stripe metadata) and never logs it.
- imani-mailer renders it into the body only (never the subject), keeps only an
  HMAC fingerprint of the request for idempotency, and never logs fields.
- The copies that persist are the buyer's: the email in their inbox (and so at
  their mail provider and the outbound SMTP provider), and anything they saved.
- A signed-in buyer's `R` is their wallet key, so nothing is emailed: they are
  told by an `imani_gift_sent` notice and their wallet takes the gift back.

Still rejected: Imani **holding** `R` (option B). Emailing it is delivery to the
buyer, not custody: no Imani system can later read it back.

The claimed and expired notices (`gift-claimed`, `gift-expired`, from the
Purchase Issuer's gift tracker) carry no link and no key.

## Consequences

- gateway-customer issuance takes a link lock (`refund`, `locktime`) next to
  the existing `lock_key`. It is checked like `/cashlink/lock`: one refund key
  that is not the lock key, `SIG_ALL`, a locktime in the window, and never a
  locktime without a refund key. Each proof carries its own `max_sats`, so the
  re-sign route can claim it like any Cashlink.
- Until that ships, payment-adapter sells only "to myself"
  (`purchase.gifting.kinds=self`), and purchase-issuer blocks a handle or email
  gift **before minting** rather than delivering it unlocked.
- Handle gifts (G7) use the same lock with the recipient's pinned pubkey in
  place of `L`, and the same window `x`: 30 days, capped by the voucher expiry
  minus 24 h (G11).
- Copy says "if it isn't claimed by <date>, you can take it back", never "it
  comes back to you".
- The buyer never sees the claim link (G8). The return page and the return link
  show `R`, which is theirs.
