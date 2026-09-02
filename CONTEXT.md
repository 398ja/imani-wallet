# Imani Wallet

The customer-facing wallet: a browser app holding bearer coupons issued by market
stalls, spent by gift-wrapped Nostr DM, with the customer's key never leaving
their own device.

## Language

### Money

**Coupon**:
A bearer claim on exactly one stall, held by the customer. Worth nothing anywhere
else, and honoured only by the stall that issued it.
_Avoid_: Voucher, token, note

**Face value**:
What a coupon is worth to the customer, in the minor units of its own currency.
Distinct from the sats backing it.
_Avoid_: Amount, value

**Nullifier**:
The one-time marker that proves a coupon has been spent. A second appearance of
the same nullifier is a replay, not a second spend.
_Avoid_: Serial, token id

**Split**:
Dividing one coupon into a spent part and a returned remainder. Bounded below by
a minimum step, so not every amount is reachable from every coupon.
_Avoid_: Change, partial spend

**Spend plan**:
The set of parts that together satisfy one requested amount, chosen from the
coupons the customer holds. Produced before anything moves, so an impossible
spend fails while the money is still whole.
_Avoid_: Selection, allocation

**Part**:
One coupon's contribution to a spend plan. Delivered independently, and able to
fail independently.
_Avoid_: Leg, chunk

**Obstacle**:
The reason a requested amount cannot be met by the coupons held. A property of
the plan, not an error from attempting it.
_Avoid_: Error, failure reason

### People

**Customer**:
Someone holding coupons and spending them. The wallet's user.
_Avoid_: User, buyer, account

**Stall**:
A trader who issues coupons and honours their own back. A stall only ever accepts
the coupons it issued.
_Avoid_: Merchant, vendor, shop

**Redemption**:
A customer returning a stall's coupons to that same stall. The ordinary end of a
coupon's life, and the case that must never need the network to authorise it.
_Avoid_: Payment, spend

**Terminal**:
One device acting for a stall, with its own key and its own fixed role. A stall
runs several, and they differ in what they may do, so "the stall" is not a single
actor at a till.
_Avoid_: Subaccount, employee, delegate, till

**Enrolment**:
Loading a terminal with the authority to act for a stall: the terminal shows the
key it generated, and the stall owner returns a voucher locked to it. Distinct
from login, which the terminal then does by itself, repeatedly.
_Avoid_: Pairing, provisioning, onboarding

### Measurement

**Scenario**:
An isolated measurement of one subsystem under load. Isolated so that a
regression names its own cause, rather than one number moving for several
possible reasons.
_Avoid_: Test, case, benchmark

**Run**:
One execution of one scenario, against one deployment, at one moment. Two runs
are comparable only if they say so; nothing about their order implies it.
_Avoid_: Trial, execution

**Baseline**:
The committed reference a run is judged against. Changing it is a deliberate act
that appears in the diff, which is what stops a slow drift from passing as
always-green.
_Avoid_: Target, threshold, SLO

**Scaling ladder**:
The same scenario measured at several coupon counts, to assert the shape of the
cost rather than its value. Survives a change of hardware, where a single
measurement does not.
_Avoid_: Sweep, series

**Fixture snapshot**:
A recording of wallet state produced by the real issuing flow, restored to make
a run reproducible. Distinct from synthetic state, which can reach any size but
drifts from what the flow actually writes.
_Avoid_: Seed, fixture, test data

### Identity and authorisation

**NAP**:
The Nostr Auth Protocol session that unlocks the customer's key and keeps it
unlocked. Authenticates a session, not a request.
_Avoid_: Login, auth

**Signed request**:
One HTTP request authorised by a NIP-98 signature binding the caller's key to
that exact URL, method and body. Authenticates a request, not a session.
_Avoid_: Token auth, API key

**Caller**:
A program spending a customer's coupons through the wallet API, holding the key
and the coupons itself.
_Avoid_: Client, integrator

**Custody**:
Holding either a customer's key or their coupons. Holding the coupons alone is
still custody, because coupons are bearer instruments.
_Avoid_: Storage, hosting
