# A card purchase issues through a terminal the stall can burn

A customer buys a coupon with a card. The stall is merchant of record and the
money lands in the stall's own Stripe account; the coupon is then minted
automatically, in seconds, by a credential the stall issued and can revoke.

**The stall issues. It is just that a terminal does the signing.**

## Why this needed deciding at all

"Issue automatically using the wallet API" does not survive contact with ADR
0002. The wallet API *plans*; the caller *signs*. It builds an unsigned event
and hands it back, and where the gateway must be called it forwards the caller's
own NIP-98 signature rather than minting a credential of its own. It has no code
path capable of issuing. So automatic issuance is not a question of which
endpoint to call, it is a question of **which key signs, and where that key
sits** when a card clears at 11pm and nobody is awake.

Four answers were on the table:

- **The stall's root key on a server.** Rejected on sight. `imani-woo` ADR 0001
  exists to keep exactly this from happening.
- **The stall's browser, when it is open.** Truest to ADR 0002, and it means an
  overnight buyer waits until morning. This is the *fallback*, below, not the
  design.
- **The customer's device pulls the coupon.** Moves delivery, not signing.
  Issuance is the stall's act; a customer cannot perform it.
- **A per-stall terminal credential.** Chosen.

## What it is

A **Purchase Issuer** holds one terminal credential per enrolled stall, minted
during Stripe setup by the same mechanism `scripts/mint-terminal-credential.mjs`
already uses: a 1-sat voucher carrying signed `merchant_metadata`, locked to a
key the terminal generated. It signs NIP-98 with that lock key and mints with
`X-Imani-Terminal-Credential` and no `issuer_id` at all, because the issuer is
the gateway's to derive from a credential it looks up in its own records.

This is `imani-woo` ADR 0008 — *the Shop issues for itself* — reached again from
a different direction, and deliberately not a second mechanism for the same
idea. That ADR records the mechanism verified end to end against a live gateway.

**ADR 0001 and 0002 are untouched.** The wallet API still holds no key and still
signs nothing. The Purchase Issuer is a *caller*, in the precise sense the
glossary already gives that word: a program holding the key, doing its own
signing, using the plan-then-sign seam ADR 0002 describes as the place a caller
inserts its own policy.

## It is a terminal, and it costs a terminal slot

The glossary defines a Terminal as one device acting for a stall, with its own
key and its own fixed role. The Purchase Issuer is that, exactly, and calling it
anything else would be inventing a second word for a thing already named.

Three things follow, and all three are the point rather than a side effect:

- **Enrolment is the enrolment that exists.** The stall issues authority to it
  the same way it issues authority to a device on a counter.
- **Revocation is the revocation that exists.** It appears in the same screen as
  the stall's other terminals, and burning it is one action.
- **`terminalAllowance.ts` gates it for free**, which means card sales sit behind
  the paid tier of ADR 0007. That is a commercial consequence and it is stated
  here rather than discovered in a pricing conversation.

## The blast radius, said plainly

A compromised Purchase Issuer can mint coupons that one stall must honour, until
that stall burns the credential. Strictly smaller than a root key leaking — the
credential grants issue and redeem for one stall, no wallet, no takings, no
profile — and revocable in a single action.

**One credential per stall, never one platform credential for all of them.** A
single shared credential would make one breach a breach of every stall, and
would leave no stall able to revoke it. The per-stall shape is what preserves
`imani-woo` ADR 0008's property, and it is the reason the credential is minted at
Stripe-setup time rather than at deploy time.

## The failure mode is the fallback

A stall with no credential, a burnt credential, or an unreachable gateway falls
back to the stall issuing by hand against a recorded Obligation. Per `imani-woo`
ADR 0008 this is **not a legacy path kept for compatibility, it is the failure
mode** — every way automatic issuance can fail lands there, and the customer's
paid purchase still shows a debt somebody can discharge.

Following `imani-woo` ADR 0009: an unreachable gateway means *unknown*, never
*unfulfilled*, so a network problem never discharges an Obligation and never
falsely accuses a stall of not having issued.

## Where it does not live

**Not in `imani-gateway-customer`**, which verifies terminal credentials. A
service that both holds and checks credentials can no longer tell anyone that a
credential was genuinely presented, and that check is the whole basis on which
the gateway decides an issuer.

**Not in `payment-adapter`**, which is a payments service and should not acquire
custody of Nostr issuing keys. It signals that a purchase was paid; what follows
from that is somebody else's business.
