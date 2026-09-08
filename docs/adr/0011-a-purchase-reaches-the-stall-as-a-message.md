# A purchase reaches the stall as a message, not as a written row

A card purchase is minted by the Purchase Issuer on a server. The stall's
dashboard reads rows from its own device, backed by NIP-60 history events on the
relay. Nothing connected the two: a stall could have a coupon issued in their
name and a dashboard showing no sale.

**The Issuer sends the stall a message; the stall's own device writes the row.**

## Why the Issuer cannot simply write the row

The obvious answer — have the Issuer publish the history event — does not work,
and the reason is in the crypto rather than in permissions.

A ledger row is published as kind 7376 with content
`nip44Encrypt(signer.pubkey, ...)`: sealed **to the writer's own key, by the
writer's own key**. That self-encryption is the property the whole scheme rests
on, and `txRecords.ts` states it plainly — hold the nsec, recover the books.

The Purchase Issuer holds a **terminal credential**, not the stall's root key
(ADR 0009, and `imani-woo` ADR 0001 before it). It can mint as the stall. It
cannot produce a blob the stall can open, because it does not hold the key both
halves of that encryption require.

## What was rejected

**Encrypt to the stall as a recipient.** Standard NIP-44, and it works. Rejected
because it makes a ledger row that is *not* self-sealed: `parseTx` would need to
try two envelope shapes, and the invariant "a row is written and sealed by the
key that owns it" would have an exception in it. One exception is how a rule
stops being checkable.

**Publish it unencrypted for the stall to pick up.** Cheapest, and it publishes
a stall's turnover to anyone watching the relay. Rejected on sight.

## What it costs, said plainly

**The stall's ledger is eventually consistent with the money.** A row exists only
after the stall's device has been online to receive the message. A stall who
sells ten coupons overnight and opens the app in the morning has ten rows arrive
in a drain, not ten rows already there.

This is the same shape as everything else in the wallet: `dm-poll` already
carries coupons to customers this way, already runs on the stall's device, and
already has a catch-up watermark for exactly the offline-for-a-week case. Using
it means one delivery mechanism to keep working rather than two.

**So the dashboard must not quietly omit what has not arrived.** The Obligation
answers "money is owed to you"; the ledger row records "this happened". They are
different questions and merging them produces a number that excludes real sales
while looking complete — the dashboard-of-lies failure `stats.ts` already warns
about in its own header. Unreconciled purchases are surfaced distinctly, in the
spirit of the existing `otherCurrencyCount`: count what could not be folded in
rather than dropping it.

## A Purchase is two rows, not one

It sounds like one object and it is not. The customer's wallet writes a receive
row sealed to the customer's key; the stall's device writes a sale row sealed to
the stall's key. Neither can read the other, and no shared record exists
anywhere.

That is already the system's shape — two parties, two ledgers — and it is worth
stating because the natural reading of "record the purchase" is a single row
somewhere authoritative. There is no such place, by design.

## Where it hangs, and one trap in it

`dm-poll` classifies `non_token_dm` as a first-class outcome: marked processed,
watermark advanced, never retried. A DM carrying no token is already an expected
thing rather than an error, which is the seam a purchase notification needs.

**It is not a free slot, though.** `dmCrypto.extractToken` returns null for a
voucher whose issuer signature was REJECTED, and that failure lands in the same
`non_token_dm` bucket — deliberately, because returning null is "what makes the
rejection real". So the two must be told apart explicitly at the point of
classification. A purchase notification that fell into the rejection path would
be dropped silently, and a rejected voucher mistaken for a notification would be
worse: it would write a sale row for a coupon the mint refused.

