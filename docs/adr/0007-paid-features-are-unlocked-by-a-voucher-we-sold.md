# A paid feature is unlocked by a voucher we sold, checked offline

Some of this app's features are not free. Multi-terminal support for a stall is
the first, and there will be more. A customer buys one by buying a **voucher we
issue**, P2PK-locked to a key they hold, carrying an expiry we signed. The app
unlocks the feature while that voucher verifies, and locks it when the expiry
passes.

Four checks, and **all four are offline**:

```
K === auth.pubkey       the request is signed by the key the voucher is locked to
issuer_sig verifies     against OUR key, which the app already has
expires_at > now        local clock
grant()                 which features this voucher confers
```

No mint call, no relay read, no account lookup. A customer with a valid voucher
gets their features on a plane.

## We are selling software, not issuing coupons

Stated first because it reorders everything else. The voucher is the delivery
mechanism for a **licence**; it is not money that must be honoured somewhere.
That has three consequences, and each one inverts a decision ADR 0006 makes for
the money path:

- **The mint is not in the authorisation path.** It issues the voucher and takes
  the payment, then steps out. `issuer_sig` and `expires_at` answer the question
  a licence check asks, and both are local. NUT-07 answers "was this spent",
  which is not the question — a subscriber HOLDS their voucher for the term
  rather than spending it.
- **There is one issuer: us.** ADR 0006 needs a `(mint, issuer)` allowlist
  because a coupon may come from any stall. A licence has exactly one legitimate
  issuer, so the check is an equality against a key compiled into the app.
- **It fails OPEN inside its window**, which is the opposite of ADR 0006 and the
  single most important line here. See below.

## Failing open, deliberately

ADR 0006 fails closed: an unverifiable credential is refused, because a coupon
landing on a stall that cannot honour it is money that stops. That reasoning does
not transfer.

**The asymmetry here runs the other way.** A wrongly-granted feature costs us a
few hours of unpaid access. A wrongly-denied one takes a working till away from a
paying merchant in the middle of trade, at a market, over an outage that is ours
rather than theirs. Only the second is a real failure.

So a verified voucher unlocks its features for a **grace window** carried on the
device, and the app keeps working through the window even if it can check
nothing at all. The window is measured from the last successful verification,
not from install, so it cannot be extended indefinitely by staying offline.

**Twenty-four hours**, matching the ceiling NAP extension 0001 §7.1 settled on
for voucher-backed sessions. That is the interval during which a lapsed
subscription still works, and it should be the shortest a customer will tolerate
being asked to reconnect. A merchant trading daily re-verifies without noticing.

The one thing that does NOT fail open is a voucher whose `expires_at` has passed,
because that is not an outage — it is the answer, and it is signed. An expired
voucher locks the feature at once.

## Renewal is a new voucher, and that is a delivery problem

Vouchers are immutable and signed, so extending a subscription means minting a
replacement with a later `expires_at` and getting it to the customer, by the same
gift-wrapped DM everything else uses.

That makes a monthly plan **twelve deliveries a year that must not be missed**,
each one a chance for a paying customer to be locked out by a relay. The grace
window above is what absorbs a late delivery, and it is a second reason the
window exists.

The alternative — a long-dated voucher plus a separate revocation channel — was
rejected for now, and the trade is worth recording rather than rediscovering. It
inverts the failure mode: renewal stops being a recurring risk, but a cancelled
subscription then depends on revocation reaching the device, which needs the
issuer ledger that cannot yet represent a P2PK-locked voucher (ADR 0006). Until
that lands, a short-dated voucher expiring on its own is the mechanism that works
with nothing but a clock.

## Sharing is bounded economically, not technically

The realistic threat is not theft, it is a customer handing their subscription to
three friends.

The P2PK lock already answers it. A voucher without `K` authorises nothing,
because the request must be signed by `K` — so sharing access means sharing the
key. **In this wallet that key is the customer's identity and their coupons.**
Sharing a subscription means sharing your wallet, and that is an economic barrier
rather than a technical one.

Economic barriers survive a patched client. That distinction is what decided the
alternative below.

### Hardware fingerprinting was considered and rejected

The obvious anti-sharing measure, and it fails three ways here:

1. **It is not enforceable.** Every check runs in a browser or a Capacitor
   container, on the customer's device, in code they control. A fingerprint gate
   is a client-side conditional with no cryptography behind it — patched out in
   minutes, unlike a signature check, which cannot be forged no matter who owns
   the machine.
2. **It fights the product.** The first feature being sold is MULTI-TERMINAL
   support. Binding a licence to one device contradicts the thing the licence
   buys, and a merchant replacing a broken tablet mid-trade would be locked out
   until we re-issued.
3. **It collects what nothing else here collects.** A fingerprint is durable
   device-identifying data about our customers, stored and matched. This
   architecture holds no accounts and no personal data by design (ADR 0001), and
   a licence check is a poor reason to start.

If concurrent use ever needs bounding, the honest lever is server-side: count
distinct sessions per voucher over a window, and rate-limit or flag. That works
regardless of what the client does, which is the test any anti-sharing measure
should have to pass.

## Consequences

- **A customer who loses their key loses their subscription**, with no recovery
  path, because we hold no account to restore it from. Consistent with the rest
  of this architecture (ADR 0001) and a real support burden, chosen knowingly.
  The mitigation is that re-issuing is cheap for us: mint a fresh voucher to a
  new key for a customer we can identify by their payment.

- **Refunds and cancellation are a burn.** The mint models *spent*, not
  *suspended* — the same property ADR 0005 records for terminals. Ending a
  subscription early means spending the voucher, which only bites once the
  device notices, i.e. within the grace window.

- **The feature gate is not a security boundary.** It stops honest customers
  from using what they have not paid for. It does not stop a determined one from
  patching the client, and nothing running on their device could. Anything that
  must actually be protected belongs behind a server-side check, where the
  voucher is verified by something the customer does not control.

- **`FIXED` is the backing strategy.** Non-splittable, minimal sat backing, for
  passes rather than money — `BackingStrategy.FIXED` names event tickets and
  boarding passes as its cases, and a licence is the same shape. A splittable
  licence would be meaningless, and backing one with real value would make
  cancelling it a refund calculation.

- **Selling access is a different posture from issuing coupons.** Coupons are
  redeemable at a stall; this is a payment taken by us for software. The
  regulatory and accounting consequences are outside this decision, and are
  flagged here rather than assumed away.

- **This does not exist yet.** No feature is gated today. Recorded before its
  first use, like ADR 0006, so the reasoning survives the gap — and so the
  difference between the two is visible: same mechanism, opposite failure
  direction, because one protects money and the other protects revenue.
