# A purchase is paid before it is issued, and the debt is visible

There is no distributed transaction across Stripe and the mint. Two writes, two
systems, and a window between them. "Ideally atomic" has to become a guarantee
that is implementable and worth having, and this is it:

**An Obligation is recorded atomically with payment confirmation, then
discharged by issuance. The customer's guarantee is atomic; the two writes are
not.**

## The two failure modes are not symmetrical

- **Paid, not issued.** The stall owes a coupon. Recoverable, visible to both
  sides, and it must not depend on anyone noticing.
- **Issued, not paid.** Value given away. Must be impossible **by
  construction**, not by diligence.

Everything below follows from refusing to trade the second for the first.

## Why not the alternatives that look more atomic

**Mint first, hold in escrow, release on payment.** Looks atomic and inverts the
dangerous failure: a coupon exists before the money does, and every bug in the
release path is a coupon given away.

**Authorise the card, mint, then capture.** Genuinely close to atomic, and
rejected for the same reason in slower motion. A capture can fail after the mint
has succeeded — insufficient funds, a cancelled card, a seven-day authorisation
expiry — and at that moment a coupon exists that nobody paid for. Being nearly
atomic is not worth reintroducing the one failure we said must be impossible.

So: **payment first, always.** The worst case is a customer who has paid and is
waiting, which is recoverable, rather than a stall who has issued and will not be
paid, which is not.

## What each side sees

**Both, from the first second**, but saying different things.

The customer sees the coupon is coming, worded so it does not invite them to
chase it, reusing the "on its way" pattern the wallet already has for the gap
between sent and settled. The stall sees an outstanding Obligation **with the
action on it**, because the stall is the only party who can discharge one.

Hiding it from the customer was considered — they can do nothing about it — and
rejected: a customer who has been charged and holds nothing needs the app to
agree that something is owed, or their next move is a chargeback.

## Discharge is confirmed, not asserted

An Obligation is discharged when issuance is **confirmed**, never when it is
merely attempted or ticked. `imani-woo` ADR 0009 records why: a stall who marks a
debt delivered before sending, or against the wrong row, leaves a customer who
paid for nothing, and no part of the system can tell.

- The manual button stays, for a stall who issued outside the automatic path.
- Only a confirmed issuance closes a debt automatically.
- **Unreachable means unknown, not unfulfilled.** A network problem must never
  discharge a debt, and must never accuse a stall of not having issued.
- The issuer is checked: a send from some other stall does not close this debt.

## Idempotency is already solved, and must be used

Stripe retries webhooks. `payment-adapter` already carries
`ProcessedStripeWebhookEvent` for exactly this, and a purchase must record its
Obligation through it. A webhook delivered twice must produce one coupon, and
the coupon is the thing that cannot be un-minted.

## What carries the buyer

The buyer's pubkey travels on the Checkout Session, in metadata and
`clientReferenceId`, so payment confirmation alone names its recipient with no
second lookup. It is validated **before** the card is charged and never typed
into a Stripe form: a mistyped npub at the moment money moves is a coupon minted
to nobody, and no refund path un-mints it.
