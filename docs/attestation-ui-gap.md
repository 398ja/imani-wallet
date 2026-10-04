# Closing the attestation UI gap

**The question:** every sale today is uncorroborated, because nothing asks the
customer to sign. What is the best way to fix that?

**The short answer:** do not build a counter ceremony. The path already exists.

**Status: IMPLEMENTED.** The customer's wallet now signs an attestation while
composing the receipt it already posts, the merchant's drain files it onto the
matching sale, and `reconcileIssuances` reports it. No new screen, no prompt at
a counter, no change to how a sale feels.

---

## What the obvious design costs, and why I am arguing against it

The natural reading of "collect the customer's signature" is a step in
`SellPage`: after the amount, before the send, show a prompt the customer taps.

That is the design this feature's own documentation warns against, and the
objection is not aesthetic. `SellPage`'s comment records the deliberate trade:

> Three screens — scan, amount, progress — because the flow is deliberately the
> simplified one: **no cart, no line items, no payment method.**

A signing step there costs:

- **A queue.** Every sale gets slower, for evidence that matters on a small
  fraction of them.
- **A second device interaction.** The customer has already shown their
  address; now they must be handed back something to approve.
- **A failure mode that eats sales.** A customer who cannot sign — locked
  wallet, flat battery, no wallet at all — becomes a merchant deciding whether
  to proceed, at a counter, under time pressure. That decision will be "skip
  it" every time, which means the ceremony costs its price and buys nothing.

And it would be **worse than useless for the disputes it targets.** A merchant
who wants to overstate a sale is the one holding the phone showing the prompt.

---

## What already exists, and is the actual answer

The customer's wallet **already sends the merchant a message when a coupon
arrives**, automatically, with no interaction from either party:

```
customer redeems  ->  dmPoll.ts:742  postPaymentReceipt()
                  ->  POST /api/v1/payment-receipts   (NIP-44, to the sender)
                  ->  merchant drains it              paymentReceiptDrain.ts
                  ->  decrypts, files a notification
```

It is fire-and-forget, never blocks a redemption, and the merchant already
decrypts and reads the payload. `ReceiptPayload` carries `voucherId`,
`faceValue`, `faceUnit`, `faceDecimals`, `redeemedAt`.

**This is the ceremony-free counterparty signal the attestation needs, and it
already runs in production.** The customer's key is on the customer's device,
which is exactly where a signature has to be made, and that device is already
composing a message to exactly the right recipient at a moment when the
customer is looking at their own phone rather than holding up a queue.

---

## The proposal: attest on receipt, not at the counter

Add the attestation to the payload the customer's wallet is already sending.

```ts
interface ReceiptPayload {
  v: 1
  voucherId?: string
  faceValue?: number
  // ...
  /** The customer's signature that they paid for this sale. */
  cashAttestation?: string
}
```

The customer's wallet signs it while building the receipt it was going to send
anyway. The merchant's drain files it against the matching `issued` row, and
`reconcileIssuances` picks it up with no further change — the verification path
is already built and tested.

### Why this is stronger than it first looks

**It is signed by the right key at the right time.** The customer holds their
own key; nobody else can produce this. That property is unchanged from the
counter design.

**It costs nothing at the point of sale.** No prompt, no queue, no sale lost to
a flat battery. A customer whose wallet cannot sign simply sends what it sends
today.

**Coverage is far higher.** A counter prompt would be skipped under pressure,
so it would corroborate the sales nobody disputes and miss the busy day. This
corroborates every sale where the customer redeems at all.

### What it does NOT do, and this is the real cost

**It attests receipt, not payment.** The customer is signing "I received this
coupon", and the merchant is reconciling that against "I authorised this sale".
Those agreeing is strong evidence the sale happened as recorded — but it is not
the customer asserting they handed over cash.

That distinction is worth being precise about rather than glossing:

| Claim | Who attests | Cost |
|---|---|---|
| Stall authorised issuing this value | the stall's warrant | none, already built |
| Customer received this coupon | receipt-time attestation | none, path exists |
| Customer paid cash for it | counter ceremony | a queue, and it would be skipped |

The third row is the only one that attests *consideration*, and it is the one
whose price is highest and whose coverage would be lowest. The second row is
**most of its evidential value for none of its cost**: a customer who received
a coupon and later disputes paying for it is contradicting a signature they
made, about a sale of a specific amount, to a specific stall, at a specific
time.

---

## Recommendation

**Build the receipt-time attestation. Do not build the counter prompt.**

The wire format, signing, verification, storage, relay round trip and
reconciliation are all done and tested. What remains is:

1. Sign the attestation in the customer's wallet while composing the receipt it
   already sends (`dmPoll.ts`, beside `postPaymentReceipt`).
2. Carry it on `ReceiptPayload`.
3. File it onto the matching `issued` row in the drain
   (`paymentReceiptDrain.ts`), which already decrypts and matches by
   `voucherId`.

That is three small changes to a path that already works, rather than a new
screen on the flow this product was deliberately simplified to protect.

**Leave the counter ceremony unbuilt** unless a real dispute demonstrates that
receipt-time evidence was insufficient. `collectCashAttestation` stays on
`IssueParams` for exactly that case: the hook is there, nothing calls it, and
it costs nothing to leave waiting.

### The one open question, now checked

The attestation binds to the **sale nonce**, which lives in the warrant inside
the coupon — so the question was whether the customer can reach it.

**They can.** Driven against a real captured token:
`parseVoucherToken(token).voucher.issuanceWarrant` feeds straight into
`parseIssuanceWarrant`, which yields the nonce. The customer's wallet already
parses the token it receives, so this is a read of a field that is already in
hand, not a new fetch.

The probe returned `absent-legacy` on the fixture, which is correct and worth
noting: that coupon predates warrants. A customer receiving one of those has
nothing to attest against, and the right behaviour is to send the receipt
exactly as today — `parseIssuanceWarrant` already models that as a distinct
state rather than a failure.


---

# Addendum: what "no UI at the counter" actually costs

Asked again after shipping the receipt-time path, and the honest answer
required checking which sales it fails to reach rather than repeating the
original argument.

## The coverage, measured rather than assumed

| Rail | Stall warrant | Customer evidence |
|---|---|---|
| Sell, owner device | yes | receipt-time attestation, automatic |
| Sell, terminal | none possible (key is not the stall's); **refused before minting since #159**, as every wallet refuses a signed `none` | n/a, no sale is made |
| **Cashback** | **was: nothing** | **impossible, forever** |

**Cashback was the real gap, and it was worse than a missing prompt.** It minted
value with no warrant at all, and the reconciliation skipped `cashback` rows
entirely — so a merchant could issue codes all day and their own audit would
show nothing. Both are now fixed: `CashbackIssuePage` signs a warrant at
issuance, and `reconcileIssuances` counts both rails.

The customer half is **permanently unreachable** there, and not for want of UI.
The flow exists to reach someone with no wallet — the code goes on a paper
receipt and is redeemed "days later on a phone that does not exist yet". There
is nobody to prompt and nobody to send a receipt back. A counter prompt would
not have closed this; it would have had nothing to prompt.

## One thing I checked and was wrong about

`restoreIssued` rebuilds sales from the relay and does not carry a warrant,
which looked like a third gap. It is not: that module is a **read-only legacy
reader** for records written before warrants existed, and its own header says
the live publisher is `txRecords` — which does carry the warrant. Nothing to
fix, and worth recording so the next reader does not re-raise it.

## So what remains, and is a counter prompt the answer?

What remains is narrow and specific: **a customer who never redeems.** The
receipt-time attestation fires on redemption, so a coupon sitting unclaimed in
a wallet has the stall's warrant and nothing from the customer.

A counter prompt would cover exactly that case. It would also:

- slow every sale to corroborate the minority that are disputed
- be skipped under pressure, so it would cover the quiet day and miss the busy one
- do nothing for cashback, which is the rail with no customer evidence at all
- still not prove cash arrived, only that someone tapped approve

**The recommendation is unchanged, and now rests on measurement rather than
argument.** The gap a prompt would close is smaller than it looked, the rail
with the worst coverage cannot use one, and the two fixes that mattered were
not UI at all.

## If the prompt is wanted anyway

`collectCashAttestation` is still on `IssueParams`, still unused, and still
costs nothing to leave waiting. Wiring it is a screen and a call — the signing,
verification, storage, relay round trip and reconciliation are all built and
tested. That is deliberate: the expensive half is done, so the decision can be
made on evidence from real disputes rather than on a guess about them.
