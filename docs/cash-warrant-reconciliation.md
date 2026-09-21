# Cash warrants, and what a merchant can actually reconcile

**Status:** IMPLEMENTED. All three recommendations below are built and tested;
this header records what shipped and the plan is kept unedited beneath it.
**Context:** `docs/plan-issuance-warrant.md`, `docs/reply-issuance-warrant.md`

---

## The short answer

**There is no cash-specific warrant, because this wallet has no payment
methods at all.** `SellPage`'s own comment is explicit:

> Three screens — scan, amount, progress — because the flow is deliberately the
> simplified one: **no cart, no line items, no payment method.**

The merchant scans the customer's address, types what they are owed, and sends.
Whether the customer just handed over cash, tapped a card, or paid nothing is
never stated to the system.

So a cash sale gets exactly what every other sale gets: a `merchant` warrant,
signed by the stall's own key, covering `(issuerId, saleTotal, decimals, unit,
nonce)`.

**What that warrant proves:** the stall authorised issuing this amount.
**What it does not prove:** that any money changed hands.

Those are the two claims §3 of the reply separated as *authorisation* and
*consideration*. On the card path, the gateway's `processor` form supplies
consideration — a Stripe charge on the stall's own account, attested by a party
outside our trust boundary. **On the cash path there is no third party, so
consideration is unattested and a `merchant` warrant is the whole story.**

That is not a flaw in the warrant. Cash has no external record by nature: the
only witnesses are the two people at the counter.

---

## Reconciliation today: the honest position

A merchant wanting to answer *"does the cash in my till match the coupons I
issued?"* can get most of the way, and the missing piece matters.

### What they have

`buildIssueTransaction` writes a row per issuance with `voucherId`, `amount`,
`unit`, `decimals`, `timestamp`, `counterparty`, and `terminalPubkey` — which
terminal handled it, if not the stall's own device. That is a per-sale ledger
already, and it is the merchant's own encrypted history rather than the
gateway's view.

So this works today:

> Sum `issued` rows for a day, compare to the cash counted. A shortfall means
> coupons were issued without money arriving.

### What they do not have, and it is the bit that would make this provable

**The warrant is not stored anywhere the merchant can read it back.**

`buildIssuanceWarrant` signs the digest, `issue.ts` puts the JSON on the
request, and the wallet keeps **nothing**. The nonce in particular exists
nowhere after the request: `saleNonce` appears in the reader and its tests and
in no persisted structure at all.

The consequence is specific. A merchant holding a coupon a customer presents can
verify its warrant offline — that is what the reader does. But a merchant
looking at **their own history** cannot show that a given `issued` row
corresponds to a warrant they signed, because the row and the warrant share no
identifier. The `voucherId` is not in the digest, deliberately: the device
cannot know it at signing time (auto-split), which is exactly why warrants
attest a sale rather than a coupon.

So reconciliation today is **arithmetic over a ledger the merchant trusts
because it is theirs**, not a cryptographic reconciliation. For a stall
reconciling its own till that is often enough. It stops being enough the moment
the question is adversarial — a terminal operator disputing what they issued, or
an owner auditing a device they did not watch.

---

## What would close it

Three options, cheapest first. None is built; I would want a decision before
building any.

### 1. Persist the warrant on the issuance row

Add `issuanceWarrant` to what `buildIssueTransaction` stores. One field, no wire
change, no protocol change.

The merchant's own history then carries, per sale, the exact bytes they signed.
Reconciliation becomes: recompute the digest from the stored sale figures,
verify the stored signature against the stall key, confirm the row is one the
stall really authorised. It answers the adversarial question for the stall's own
records.

It does **not** link a row to the coupons that came out of it. For that:

### 2. Record the minted voucher ids against the sale

The portal knows the ids; the wallet already receives them (`createVouchers`
returns a list, and the auto-split comment records that reading `items[0]` once
lost real money). Storing them beside the warrant makes the chain complete in
one direction:

```
warrant (signed by the stall)  ->  sale row  ->  [voucherId, ...]  ->  coupons
```

A merchant could then take any coupon presented back to them and find the sale
that produced it, which is the actual reconciliation question at a till.

**The limit worth stating:** this links coupons to sales using **the wallet's
own record of what the server returned**. A compromised issuing service that
minted extra coupons against a real warrant would not appear in it, because it
would never have told the wallet. That is the replay limitation already recorded
in `IssuanceWarrant`'s class comment, and option 2 does not fix it — it makes
the honest case auditable, not the dishonest one impossible.

### 3. A cash attestation the customer co-signs

The only thing that would attest *consideration* on a cash sale: the customer's
key signs "I paid 2500 for this", alongside the stall's "I authorised 2500".

It is the strongest option and the one I would argue against for now. It puts a
second signing step between a customer and their coupon at a counter with a
queue, to defend against a dispute between two people who were both standing
there. ADR 0009's reasoning about ceremony cost applies with more force here
than it does to the issuing side.

---

## What shipped

All three, on request.

| # | What | Where |
|---|---|---|
| 1 | Warrant persisted on the issuance row, and re-checkable | `transactions.ts`, `reconcileIssuance.ts` |
| 2 | Sibling voucher ids per sale, so a returned coupon finds its origin | `saleFor`, `saleIsComplete` |
| 3 | Customer-signed cash attestation, optional | `cashAttestation.ts` |

**A defect found while building 1, worth recording.** A per-row ceiling check
cannot catch an understated split sale: a warrant for 2500 legitimately covers
a part worth 833, so deleting one part of a three-part sale leaves every
remaining row verifying perfectly. Reconciliation now groups the parts of a
sale and requires them to sum to the warranted total.

**A second defect, in my own fix for the first.** That grouping originally
keyed on the warrant JSON. BIP-340 signing uses fresh auxiliary randomness, so
the same sale signed twice produces different bytes — every part would have
landed in its own group of one, every group would have trivially summed to
itself, and the check would have passed on everything including the
understatement it exists to catch. It now keys on the sale **nonce**, which is
inside the digest and therefore cannot be edited without breaking a signature
that was already verified. Caught by a test that expected a *valid* split to
reconcile and watched all three parts come back `mismatch`.

**On 3, the shape matters more than the cryptography.** The attestation is
optional and must stay so: a missing one is the ordinary case and never a
refusal. It is reported as a separate `paid` field rather than folded into the
verdict, because *did the stall authorise this* and *did anyone say money
arrived* are different questions, and collapsing them would let a warrant read
as proof of payment. The amount is checked for **equality**, unlike a warrant's
ceiling — one payment for one sale, so a smaller attestation is not a weaker
valid one, it is an attestation for a different amount.

## Original recommendation, before any of it was built

**Do 1. Consider 2. Leave 3 unless a real dispute makes the case.**

Option 1 is a single stored field and turns "trust my own ledger" into "verify
my own ledger". Option 2 is more work and answers the question a merchant
actually asks when a coupon comes back. Option 3 buys consideration and costs
the thing the Sell flow was deliberately simplified to protect.

Worth being plain about the ceiling on all three: **no amount of signing makes
a cash sale prove that cash arrived.** Anything here proves the stall meant to
issue a coupon of that value. Whether the notes went into the till is a physical
fact the protocol cannot reach, and a merchant who wants that assurance needs a
till count, not a signature.
