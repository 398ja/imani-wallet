# A customer-to-customer transfer is signed by both parties, under keys that name neither

When one customer sends a voucher to another, the sender now signs the
transfer and the receiver publishes an attestation that they received it (#91).
Neither signature is made with an identity key in public, neither can block the
transfer, and a customer still never publishes a kind-7377.

## The claim is different, so the kind is different

A kind-7377 says "I honoured this coupon". `reconcileAttestations` reads every
7377 under a merchant's ledger key and matches it to a redemption row, and the
audit reader sums their commitments. A customer receiving a gift has honoured
nothing, and a 7377 from them would be a false entry in a ledger that has no
row to match it.

The receiver's claim is "I received this transfer from the holder of this
sender key". That gets its own kind, **7378** (`TRANSFER_RECEIPT_KIND` in
`src/lib/attestationKind.ts`), beside 7375/7376/7377 for the same reason 7377
sits there. It is a regular kind: append-only, like the redemption ledger. No
other number in 7378's neighbourhood is used anywhere in this repo.

## What travels, and how

The gateway cannot carry the sender's signature. `/api/v1/atomic-send` accepts
a fixed set of fields and ignores the rest, and the only free-text field, `memo`,
is hashed into the idempotency check, embedded in the Cashu token and shown to
the recipient as their note. So the sender publishes a **second NIP-17 gift
wrap** of its own, straight to the relay, once the saga reports `COMPLETED`. Its
content is:

```json
{
  "type": "imani_transfer_signature",
  "v": 1,
  "transfer": "<sent_voucher_id>",
  "nonce": "<32 random bytes, hex>",
  "sender": "<sender identity pubkey>",
  "recipient": "<recipient identity pubkey>",
  "amount": 250, "unit": "EUR", "decimals": 2,
  "transferKey": "<sender's per-transfer pubkey>",
  "transferSig": "<transferKey's signature over the public tag>",
  "sig": "<sender IDENTITY signature over all of the above>"
}
```

`transfer` is `sent_voucher_id`, which the gateway already defines as
`sha256(send_token)[:32]` and returns to the sender on the status response. The
receiver computes the same value from the token they redeem
(`getTokenFingerprint`). It is the one identifier both parties hold without the
sender ever holding the send token, which stays server-side.

`v` is there so a later version can add fields: #94's signed bundle manifest is
the expected first one. A reader refuses a version it does not know.

## Which key signs what

Three keys, and only one of them is an identity key:

| Signature | Key | Seen by |
|---|---|---|
| `sig` over the whole payload | sender IDENTITY | the receiver only (inside the gift wrap) |
| `transferSig` over the public tag | sender per-transfer key | public, on the 7378 |
| the 7378 event itself | receiver per-transfer key | public |

The per-transfer keys are `sha256(tag || identitySecret || ':' || t)`, the same
construction as the merchant ledger key in `attestation.ts`, scoped to one
transfer instead of one merchant. A ledger key is a deliberate fetch handle for
one stall. A customer needs no handle, and a stable one would let anyone group
every gift a person ever received. So every 7378 is signed by a key used exactly
once, and derived rather than random so either party can reproduce it from their
own key and the tag after a device wipe.

The identity signature is what makes the transfer key mean anything: it binds
"this per-transfer key is mine, for this transfer, to you, for this amount" to
the sender's real key, and only the receiver ever sees it. The receiver can
later disclose the payload to prove who sent it. Nobody else can.

## What is published

`t = sha256("imani-transfer-v1:" || transfer || ":" || nonce)`, as the `n` tag,
plus the sender's per-transfer key and `transferSig`, plus a Pedersen commitment
to the amount. The blind is derived from the nonce, so **both** parties can open
the commitment and nobody else can.

Not published: either identity, the amount, the unit (except alongside a
commitment, see below), the voucher id, or `transfer` itself.

**Why the nonce.** `transfer` is a token fingerprint: it is the `token_id` on
the receiver's row and the gateway's `sent_voucher_id`. A tag derived from it
alone could be recomputed by the gateway operator, who knows both parties to
every send, and by anyone who has seen the coupon's id. Mixing in a nonce that
only ever travels inside the encrypted wrap means the gateway, which relayed the
coupon, cannot find the public record of it.

**Why a commitment at all.** A receipt that commits to nothing is a timestamp.
The commitment lets either party later prove the amount to an auditor of their
choosing, exactly as `verifyDisclosedTotal` does for a merchant. It is only
included when the receiver's verified credited value equals the amount the
sender signed; otherwise the event is published without one rather than
committing to a figure the two parties disagree on. The unit rides with it,
because a commitment is not summable without one. A rare unit is the same
residual leak `docs/research/redemption-attestation-privacy.md` already accepts
for merchants.

## Linkability, stated plainly

- The sender's public signature and the receiver's 7378 are linked to each other
  by being in the same event, under the same `t`. That is the requirement.
- Neither is linked to an identity, to another transfer, or to the gift wrap
  that carried the coupon.
- An observer learns that **some** customer-to-customer transfer was received
  at a certain time. The count and timing of 7378s across the relay is a
  cardinality leak for the network as a whole, not for a person. Accepted.
- The receiver can link sender identity to the event (they hold `sig`). They
  could anyway: they received the coupon from that person.

## It never blocks, and never reverses

The money has moved before either signature exists. So:

- **Sender.** Signed and wrapped after the saga completes and the local row is
  written, fire-and-forget. A locked wallet, a missing `sent_voucher_id` (an
  older gateway), or a relay refusing the wrap costs the receipt, never the
  send. `settleSend` also runs for sends finished late by
  `reconcilePendingSends`, so those are signed too.
- **Receiver.** Published after redemption, fire-and-forget, never throwing.
  The two messages can arrive in either order, so each side is remembered
  locally until the other turns up. A receiver who never opens their wallet
  simply never publishes, and the transfer is exactly as complete as it was.
- **A signature that does not verify is ignored**, not escalated. It is evidence
  that was optional in the first place, as `cashAttestation.ts` says of its own.
- **Without a sender signature, nothing is published.** A unilateral "I received
  something" has nothing to link to and no auditable value, and would be a
  public record of a gift the sender never asked to have recorded. A transfer
  from an older build, or a coupon issued directly by a stall, therefore
  produces no 7378.
- **A failed publish is not retried** in this change. Unlike a merchant's
  ledger, nothing reads these for completeness yet, so there is no sweep to
  make absence mean anything. Recorded as the obvious follow-up if one ever
  does.

## Merchants are unchanged

A wallet with a stall record keeps publishing 7377 through `attestRedemption`
and publishes no 7378. `reconcileAttestations` reads 7377 only and is untouched.

## Deployment assumption

The sender's wrap is published to `RELAY_URL`, and reaches the receiver because
the gateway's `RelayIngestPump` ingests every kind-1059 from that relay. A
deployment where the wallet cannot reach the relay loses the signature and
therefore the receipt, and nothing else.
