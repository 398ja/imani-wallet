# Spec: Subscriptions

**Source:** [ADR 0007](../../docs/adr/0007-paid-features-are-unlocked-by-a-voucher-we-sold.md)

Related: [ADR 0005](../../docs/adr/0005-terminals-are-authorised-by-locked-vouchers.md)
(terminals), [ADR 0006](../../docs/adr/0006-a-voucher-guarded-request-is-signed-by-its-lock-key.md)
(the same binding on the money path), and [the terminals spec](../terminals/spec.md),
which this one gates.

## Problem Statement

Some features cost real money to build and to run, and multi-terminal support is
the first. There is no way to charge for anything: the app has no accounts, no
subscription record, and no purchase flow, and the architecture removes the
usual place to put one — a stall provisions terminals without the gateway
learning they exist, deliberately, so there is nothing server-side to attach a
plan to.

What is missing is a way to sell a capability to one stall, have their app
believe it, and have that belief expire — without acquiring the account
database that every other decision here has avoided.

## Solution

A stall buys a **voucher we issue**, P2PK-locked to a key they hold and carrying
an expiry we signed. Their app unlocks the feature while that voucher verifies,
and locks it when the expiry passes.

The check is four things, and all four are local: the request is signed by the
key the voucher is locked to, our issuer signature verifies, the expiry is in
the future, and the grant says which features it confers. No mint call, no relay
read, no account lookup. A subscriber's terminals work on a market's bad
connection, which is the only condition that matters.

Subscriptions are sold **per stall**, not per terminal, because the licence
check sees one voucher and cannot count a fleet the gateway deliberately does
not know about. A stall gets one terminal free — their own device, which is what
they have today — and the subscription buys the second onwards.

When a subscription lapses, **the tills keep serving**. Growth freezes: no new
enrolments, and the extra terminals drop away down to the free one. Nothing is
revoked, so renewing restores service without re-enrolling a single device.

## User Stories

1. As a stall owner, I want to run more than one till, so that two people can serve at once.
2. As a stall owner, I want to know what running more tills costs before I commit, so that I can decide whether it pays for itself.
3. As a stall owner, I want to pay in my own currency or in sats, so that I am not forced through an exchange I did not ask for.
4. As a stall owner, I want to buy without creating an account, so that adopting this costs me no identity I did not already have.
5. As a stall owner, I want my subscription to arrive in my wallet, so that there is nothing to activate and no code to type.
6. As a stall owner, I want my tills to keep working when the network does not, so that a bad connection is not a closed stall.
7. As a stall owner, I want to be told before my subscription ends, so that renewing is a decision rather than a surprise.
8. As a stall owner, I want to be told again on the last day, so that one missed message is not a lapse.
9. As a stall owner, I want a lapse to take away extra tills and not my ability to trade, so that a billing problem is never a closed stall.
10. As a stall owner, I want renewing to restore my tills immediately, so that paying is the whole of the remedy.
11. As a stall owner, I want to stop simply by not renewing, so that cancelling needs no conversation.
12. As a stall owner, I want to see what I paid and until when, so that the subscription is its own receipt.
13. As a stall owner, I want my subscription not to be counted as money in my balance, so that my takings figure stays true.
14. As a stall owner, I want to know that losing my key loses my subscription, so that I treat the key accordingly.
15. As a stall owner who lost a key, I want a way to be re-issued, so that a lost phone is not a lost year.
16. As a stall owner, I want to be told plainly when I have reached my free till, so that I know what to do next.
17. As a member of stall staff, I want the till I am on to keep working whatever the owner's billing is doing, so that I can serve the queue.
18. As a pilot user, I want the same purchase and expiry path as a paying customer, so that what I test is what ships.
19. As the seller, I want to tell a pilot from a paying customer, so that support and revenue are not guesses.
20. As the seller, I want to find a customer's subscription when they ask for help, so that having no accounts does not mean having no records.
21. As the seller, I want a customer's renewal to keep the same subscription identity, so that a year of renewals is one relationship.
22. As the seller, I want the gate exercised from the first day the feature exists, so that the paid path is never the untested one.

## Implementation Decisions

**The unit of sale is the stall.** One voucher, however many terminals. Per-terminal
pricing was rejected because it is not enforceable here: ADR 0005 keeps no
per-terminal record on the gateway, so a count would have to be client-side and
trusted. If price should scale later, it scales by tier, not by a device count
we cannot observe.

**Priced in fiat, payable in fiat or sats.** A stall in Douala thinks in XAF and a
sats-native buyer should not pay an FX spread to buy software. The price is
quoted in one fiat currency and settled either way, and the voucher records what
was actually paid.

**The term is annual by default, monthly available.** Renewal is a *delivery* —
minting a replacement voucher and getting it to the device — so a monthly plan is
twelve chances a year for a relay to lose a paying customer's access. Annual
makes that risk annual. Monthly exists for stalls that cannot commit, priced so
that annual is obviously better.

**Selling is out-of-band first.** There is no purchase flow, and building one
before knowing what people ask is guessing. The first customers are sold to
manually with the issuance machinery that already exists. This is explicitly a
pilot mechanism: it does not scale past a few dozen and the in-app flow is the
real answer.

**One terminal free, and it is the owner's device.** The owner's device counts as
terminal 1 and stays exactly as it is — authenticating as the stall, holding the
stall's key, not enrolled. It is counted, not converted. Making it a real
enrolled terminal is architecturally cleaner and is a migration of every existing
merchant's device for no benefit they can perceive.

**The gate is at enrolment, on the owner's device.** A terminal cannot exist
without the owner creating it, so refusing enrolment gates the feature entirely,
on the one device that holds the licence. Terminals themselves never check the
licence and never carry it. A terminal that stopped mid-shift because a
*subscription* expired is precisely what ADR 0007's fail-open reasoning forbids.

**The count is client-side, and that is accepted.** ADR 0007 already states the
gate stops honest customers rather than determined ones. A server-side count
would unpick the decision that makes terminals cheap, and cryptographic
enrolment tokens add a credential lifecycle to recover a small amount of
revenue leakage. A merchant technical enough to patch the client is not the
customer whose loss is worth that complexity.

**A lapse suspends; it never revokes.** Terminal credentials stay valid and
unburned. The licence check is what refuses them, so renewal restores service
instantly. This is only possible because the two vouchers are separate — the one
a stall issues to authorise a terminal, and the one we issue entitling them to
run terminals at all — which is a good argument that they should be.

**Two clocks, and they never interact.** The terminals spec's twelve-hour session
ceiling asks "is this terminal still authorised by its stall?" and fails closed.
The licence's twenty-four-hour grace window asks "is this stall still a
customer?" and fails open. A terminal re-authenticates every twelve hours
regardless, and the licence never stops an existing till. Written down, these
stop being a conflict.

**Cancellation is not renewing.** No refunds, no early burn. The voucher is paid
for and expires on its own; burning it early buys nothing and costs the customer
a day of unpredictability while the grace window drains. "Cancel" is the absence
of a mechanism rather than one more.

**The voucher's face value is the price paid.** It costs nothing, and it makes the
credential its own receipt — which ADR 0007 notes it becomes regardless. The
hazard is a wallet screen summing a licence into a balance, so the grant type
must be visible enough that no total includes it.

**A subscription id in `merchant_metadata` survives renewal and key loss.** A
renewal is a new voucher with a new `voucher_id`, and a re-issue after key loss
is a new `K`, so neither identifies a customer over time. A stable id in the
voucher's own metadata is the thread support follows, without becoming an
account: it is carried in the credential, not stored by us.

**Pilots hold real vouchers, marked.** A long-dated voucher with a `pilot` marker
in metadata, never a build-time bypass. A bypass makes the paid path the
untested one, which is the failure this whole sequencing exists to avoid, and
the marker is what separates support and revenue from guesswork.

**The licence machinery ships before the feature it gates**, proven against an
internal diagnostics screen. Purchase, delivery, verification, expiry and lapse
are the risky parts, and proving them against a screen no customer sees means a
wrongly-open or wrongly-closed gate is a development detail. Terminals then land
with the gate present and closed, so the gated path is the only path anyone
exercises.

## Testing Decisions

The properties worth asserting here are **negatives and clocks**, and the clocks
are the part a confirmatory test will miss. A licence that verifies is easy; one
that stops verifying at the right moment, and keeps working for exactly as long
as it should when nothing can be checked, is where the bugs are.

Three seams:

- **The licence module** (new, `packages/licence/`): a pure function over a
  voucher, a key and a clock. Everything about expiry, grace and grant is
  testable here without a network, a store or a DOM — which is the reason for the
  package boundary.
- **Enrolment**: refused past the free allowance without a licence, and the
  refusal is at the point of enrolment rather than in a screen that hides a
  button.
- **Lapse**: extra terminals stop, the free one does not, and no voucher is
  burned. Renewal restores without re-enrolment.

Adversarial rather than confirmatory, because a bug in either is a revenue or a
trade failure rather than a defect:

- **A voucher signed by anyone but us must not grant anything**, including one
  that is otherwise perfectly formed and carries a generous grant. This is the
  check that stops a customer minting their own subscription.
- **A lapsed subscription must not stop the free terminal.** Tested by lapsing
  with terminals live and asserting the till still serves, not by asserting the
  licence returns false.

The grace window needs a test that fails without it: verify, then make every
check impossible, then assert the feature still works — and assert it stops once
the window passes. A test that only checks the happy path would pass against an
implementation with no window at all.

## Out of Scope

- **The in-app purchase flow.** Sold out-of-band first, deliberately, and the
  flow is its own work once there is evidence of what it should do.
- **Incognito sending**, which was considered as the first paid feature and is
  not. It carries an unresolved collision with `sender_pubkey` being taken from
  the verified signature, and a question about whether buying a privacy feature
  from us deanonymises the person using it. Neither is settled and neither
  belongs here.
- **Tiers and a feature catalog.** One feature, one licence. A second paid
  feature is when the shape of a catalog becomes knowable.
- **Refunds, pro-rata, and mid-term cancellation.** Decided against.
- **Per-terminal or usage-based pricing.** Not enforceable without the
  server-side record ADR 0005 removes.
- **The upstream `P2PK_VOUCHER` work.** Released, but the ledger still cannot
  represent a locked voucher, so near-immediate revocation stays out of reach —
  and the lapse design above does not need it.
- **Customer-facing changes.** A customer buying coupons sees nothing of this.

## Further Notes

The sequencing is unusual and deliberate: the machinery lands first against a
screen nobody sees, then the feature lands already gated. The alternative — ship
terminals free and gate them later — is the one move guaranteed to take something
away from people who already have it, and it was rejected on that basis rather
than on effort.

Nine of the terminals spec's ten tickets are `ready-for-agent` and the tenth
unblocked when `P2PK_VOUCHER` was released. So the gated feature is buildable now
and this spec is what decides whether it earns anything.
