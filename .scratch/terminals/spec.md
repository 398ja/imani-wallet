# Spec: Terminals

**Source:** [ADR 0005](../../docs/adr/0005-terminals-are-authorised-by-locked-vouchers.md)

## Problem Statement

A stall is one person with one key, and the app assumes it. In practice a stall
runs several devices: a redemption-only point at the door, a full till at the
counter, a phone the owner carries. Today every one of them has to log in as the
stall itself, holding the key that can issue coupons, read every sale, and change
the business.

So an owner with staff has two bad options. Share the key, and a leaving employee
takes the stall with them, with no way to withdraw it short of moving to a new
identity and stranding every coupon already issued. Or keep the key, and be the
only person who can serve a customer.

What is missing is a way to put a device on the counter that can do exactly one
job, and to take that ability away again without touching anything else.

## Solution

The owner creates a terminal for each device and gives it a role: redemption
only, or issuance and redemption. The device generates its own key, shows it as a
QR, and the owner scans it and hands back a voucher locked to that key. The
terminal is now loaded, and logs itself in from then on.

Neither QR in that exchange is a secret. The one the terminal shows is a public
key. The one the owner returns is useless to anyone who does not hold the key it
was locked to, so it can be photographed, saved, or intercepted without granting
anything.

The terminal sees only what its role allows. A redemption-only terminal has no
Sell button and no dashboard, and not as a matter of hiding: the session it holds
carries no permission to do either, so going around the UI fails too.

To withdraw a terminal, the owner revokes it. The device stops working within the
trading day, and does so even if it was lost, stolen, or destroyed, because the
owner can revoke without it.

## User Stories

1. As a stall owner, I want to create a terminal with a name, so that I can tell my devices apart in my records.
2. As a stall owner, I want to choose a terminal's role when I create it, so that a device can only do the job I put it there for.
3. As a stall owner, I want to enrol a terminal by scanning the key it shows me, so that I never have to type or transfer a secret.
4. As a stall owner, I want the enrolment QRs to be safe to observe, so that setting up a till in a busy market is not a security event.
5. As a stall owner, I want to see all my live terminals with their names, roles, and when each was last used, so that I know what is out there.
6. As a stall owner, I want to revoke a terminal, so that a device I no longer trust stops trading for me.
7. As a stall owner, I want to revoke a terminal I cannot physically reach, so that a lost or stolen device is not a permanent hole.
8. As a stall owner, I want to know how long revocation takes to bite, so that I can decide whether to also close the stall.
9. As a stall owner, I want a revoked terminal's past sales to stay in my records, so that revoking is not the same as erasing.
10. As a stall owner, I want to re-enrol a replacement terminal quickly, so that a broken device costs me minutes rather than a day.
11. As a stall owner, I want my own device to keep working exactly as it does now, so that adopting terminals is not a migration.
12. As a stall owner, I want every coupon issued at any terminal to carry my stall, so that customers hold coupons from me and not from a device.
13. As a stall owner, I want all takings to arrive at my key wherever they were collected, so that no money sits on a device I might lose.
14. As a stall owner, I want to see which terminal handled a sale, so that I can reconcile a till and answer questions about a transaction.
15. As a stall owner, I want a terminal to be unable to create or revoke other terminals, so that delegating a job does not delegate control.
16. As a stall owner, I want a terminal to be unable to change my business details, so that my stall's identity stays mine.
17. As a stall owner, I want to be sure a terminal cannot act for another stall, so that a credential I issue is bounded by my own business.
18. As a member of stall staff, I want to open the terminal for trade with a passphrase, so that a stolen device cannot simply be switched on.
19. As a member of stall staff, I want the terminal to show only the actions it can perform, so that I am not offered buttons that fail.
20. As a member of stall staff, I want to take a payment without any owner present, so that the stall can trade while the owner is away.
21. As a member of stall staff, I want to be told plainly when the terminal has lost its authority, so that I stop serving rather than repeatedly failing.
22. As a member of stall staff, I want redemption to keep working when connectivity is poor, so that the queue keeps moving.
23. As a customer, I want the coupon I buy to name the stall, so that I know who honours it.
24. As a customer, I want to learn nothing about which till served me, so that a stall's staffing is not published to everyone holding a coupon.
25. As a stall owner, I want decommissioning a terminal from the device itself to also revoke it, so that a wiped device is not still authorised.
26. As a stall owner, I want to be warned that enrolment needs connectivity, so that I set up terminals before the market opens rather than during it.

## Implementation Decisions

**A terminal is an actor with a disposable identity.** The key `K` is generated on
the terminal, never disclosed, and expected to be replaced whenever the terminal
is re-enrolled. Every existing assumption that a session pubkey is durable has to
be revisited where terminals reach it, and two such assumptions are load-bearing
today (see the issuance and takings decisions below).

**Authorisation is a P2PK-locked voucher, resolved at login.** NAP extension 0001
supplies the mechanism: the voucher is locked to `K`, carries the role and the
issuing stall in its tags, and the gateway derives the session's permissions from
it instead of from a stored row. This means no per-terminal record on the
gateway, and no registration step before a terminal can be used.

**Permissions are parameterised by the stall.** `grant()` emits
`voucher:redeem:<issuer_pubkey>` rather than a bare `redeem`. This is the
cross-stall boundary, and it is expressed in the permission string so that the
registry validation applied to grant output can see it. A bare role would
authorise a terminal against every stall on the deployment.

**Issuance takes the issuer from the voucher, not the session.** Issuing
currently derives the issuer pubkey from whoever the portal authenticated, and
documents that as deliberate. Under terminals that would stamp coupons with a
burner key that stops existing at the next re-enrol. The verified voucher's
`issuer_pubkey` becomes the source, and issuance with no voucher present is
refused rather than falling back to the session.

**Terminals never receive value.** A payment request a terminal displays names
the stall's pubkey as recipient, so takings are gift-wrapped to the stall. The
terminal is an instrument for asking, not a place money rests. This is what makes
revocation safe: burning a terminal's voucher destroys access and never funds.

**Revocation is spending the voucher, and the owner keeps the means.** At
enrolment the owner retains what is needed to spend each terminal's proof, so
revoking a device that is lost or destroyed is still possible. Keyset rotation
remains the blunt instrument that invalidates every terminal at once.

**There is no pause.** The mint models spent, not suspended. Withdrawing access
is revocation and restoring it is re-enrolment, which is seconds of work. A
resumable pause would require exactly the server-side record this design removes.

**Staleness is bounded at twelve hours.** A session outlives its credential up to
the session ceiling. Twelve hours is one trading day, so a terminal
re-authenticates when it opens and never mid-shift, and a revoked terminal is
dead by the end of trading. The ledger watcher that would cut this to seconds is
blocked upstream.

**Degraded login is redeem-only.** When the mint is unreachable a session may be
issued on the DLEQ alone, carrying redemption but not issuance, because
redemption must never need the network to authorise and issuance is
value-bearing.

**Enrolment is online and unbatched.** Minting needs the mint, and there is no
degraded mode for creating a credential. Pre-minting a pool of unassigned
terminal vouchers is rejected: those are bearer credentials to the stall sitting
in a drawer.

**`K` is passphrase-protected at rest,** in the existing key store, entered when
the terminal opens for trade.

**Terminal attribution is private to the stall.** The terminal that handled a
movement is recorded on the stall's own copy of the record. It is not on the
coupon and not visible to the customer.

**Decommissioning burns then wipes.** The device-side action revokes its own
voucher before erasing, so a device leaving the stall is not merely cleared. Its
wording is written for a terminal: the customer logout copy promises recovery
from a backup key, and every clause of that is false here.

## Testing Decisions

A good test here asserts an externally observable property, and the properties
worth naming are mostly *orderings* and *negatives*: what must happen before what,
and what must never leave the device. `registration.test.ts` is the prior art,
asserting that nothing persists until the handle is claimed, with collaborators
mocked at the module boundary.

Four seams, preferring the ones that exist:

- **The terminal module** (new, and the only new seam): enrolment ordering, and
  that no private key material appears in anything it emits.
- **Issuance**: the issuer stamped comes from the voucher; absent a voucher,
  issuance is refused rather than falling back to the session pubkey.
- **The payment request builder**: the recipient is the stall's pubkey, never the
  terminal's, whoever is signed in.
- **Logout**: the terminal path burns before it wipes, and does not wipe if the
  burn was never attempted.

Two properties deserve tests that are adversarial rather than confirmatory,
because they are the ones where a bug is a security hole rather than a defect: a
terminal's permission must not resolve against a second stall, and a terminal
without the issuance role must be refused at the API and not merely in the UI.

## Out of Scope

- The upstream `P2PK_VOUCHER` composite kind in `cashu-lib`, `cashu-voucher`, and
  `cashu-mint`. It blocks the real credential path and is not built here.
- The Nostr ledger watcher that would make revocation near-immediate. Blocked
  upstream: the ledger cannot represent a P2PK-locked voucher.
- Pause and resume, decided against.
- Per-terminal spending limits, opening hours, or any policy beyond the role.
- Cross-server single-use of a credential, which extension 0001 records as an
  accepted multi-use property.
- Customer-facing changes. A customer's wallet is untouched by this.

## Further Notes

**This feature is sold, not free** — decided after this spec was written, in
[the subscriptions spec](../subscriptions/spec.md) and
[ADR 0007](../../docs/adr/0007-paid-features-are-unlocked-by-a-voucher-we-sold.md).
Three things here read differently as a result, and none of them changes a
ticket:

- **A stall now holds two vouchers**, doing different jobs. The one this spec
  describes authorises a terminal to act for its stall and is issued by the
  owner. The other entitles the stall to run terminals at all and is issued by
  us. The separation is what lets a lapsed subscription suspend terminals
  without burning their credentials.
- **The twelve-hour ceiling and the licence's twenty-four-hour grace window never
  interact.** They answer different questions and fail in opposite directions:
  the ceiling asks whether a terminal is still authorised by its stall and fails
  closed; the licence asks whether the stall is still a customer and fails open.
  A terminal re-authenticates every twelve hours regardless.
- **The owner's device is terminal 1 and is free.** It is counted, not converted:
  it keeps authenticating as the stall, holds the stall's key, and is never
  enrolled. Everything below about a terminal's disposable identity applies to
  terminals 2 onwards.

The gate lands at enrolment on the owner's device, so nothing in this spec's
tickets needs to know about licences.

The sequencing is that everything except the credential itself can be built now.
The owner's terminal list, the enrolment screens, the role-gated UI, and the
corrected issuer and recipient handling all stand on their own, and the mint work
lands underneath them.

The riskiest single line in the feature is the stall parameter on the granted
permission. It is worth reviewing on its own.
