# Imani Wallet

The customer-facing wallet: a browser app holding bearer vouchers issued by market
stalls, spent by gift-wrapped Nostr DM, with the customer's key never leaving
their own device.

## Language

### Money

**Voucher**:
A bearer claim on exactly one stall, held by the customer. Worth nothing anywhere
else, and honoured only by the stall that issued it. What every customer screen
calls it, and what every count counts: one voucher is one voucher however many
stored rows or proofs it is held as.
_Avoid_: Coupon (that is the checkout code below), token, note, proof, part

**Coupon code**:
A code typed at an online shop's checkout that spends the customer's vouchers
from one stall (#402). The only thing the app calls a coupon.
_Avoid_: Voucher, checkout token

**Proof**:
One signed piece of a voucher's backing, at the mint. A voucher is held as one or
more proofs, and some flows store one row per proof (a coupon code's change, a
Cashlink take-back). Never shown to the customer, and never counted as a voucher.
_Avoid_: Voucher, part, piece

**Face value**:
What a voucher is worth to the customer, in the minor units of its own currency.
Distinct from the sats backing it.
_Avoid_: Amount, value

**Nullifier**:
The one-time marker that proves a voucher has been spent. A second appearance of
the same nullifier is a replay, not a second spend.
_Avoid_: Serial, token id

**Split**:
Dividing one voucher into a spent part and a returned remainder. Bounded below by
a minimum step, so not every amount is reachable from every voucher.
_Avoid_: Change, partial spend

**Spend plan**:
The set of parts that together satisfy one requested amount, chosen from the
vouchers the customer holds. Produced before anything moves, so an impossible
spend fails while the money is still whole.
_Avoid_: Selection, allocation

**Part**:
One voucher's contribution to a spend plan. Delivered independently, and able to
fail independently. A word for the code, not the screen: the customer is told how
many vouchers a payment used.
_Avoid_: Leg, chunk

**Obstacle**:
The reason a requested amount cannot be met by the vouchers held. A property of
the plan, not an error from attempting it.
_Avoid_: Error, failure reason

### People

**Customer**:
Someone holding vouchers and spending them. The wallet's user.
_Avoid_: User, buyer, account

**Stall**:
A trader who issues vouchers and honours their own back. A stall only ever accepts
the vouchers it issued.
_Avoid_: Merchant, vendor, shop

**Redemption**:
A customer returning a stall's vouchers to that same stall. The ordinary end of a
voucher's life, and the case that must never need the network to authorise it.
_Avoid_: Payment, spend

**Terminal**:
One device acting for a stall, with its own key and its own fixed role. A stall
runs several, and they differ in what they may do, so "the stall" is not a single
actor at a till. Not always a device on a counter: the Purchase Issuer is one
too.
_Avoid_: Subaccount, employee, delegate, till

**Enrolment**:
Loading a terminal with the authority to act for a stall: the terminal shows the
key it generated, and the stall owner returns a voucher locked to it. Distinct
from login, which the terminal then does by itself, repeatedly.
_Avoid_: Pairing, provisioning, onboarding

**Takings**:
Vouchers redeemed back to a stall. They are gift-wrapped to the stall's own key,
never to the terminal that asked for them, so a terminal handles no takings even
though it is where the customer pays.
_Avoid_: Revenue, receipts, float

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

**Behaviour**:
What one kind of actor does, repeatedly, over a trading day: the acts and the
rate they happen at. Named after the actor rather than the endpoint, so a
behaviour survives a change of API. Sits between a scenario, which measures one
subsystem, and a mix, which runs several behaviours at once.
_Avoid_: Profile, persona, workload, journey

**Mix**:
Several behaviours running together on one clock, at the proportions a real
trading day has. Deliberately gives up a scenario's isolation to answer what
isolation cannot: whether these actors can coexist. A regression in a mix names
a suspect, not a cause, and the scenarios are what confirm it.
_Avoid_: Blend, composite, soak, day

**Shaped day**:
A mix whose load follows a day's own curve (a morning build, a midday peak, a
slower afternoon) rather than holding one level. Realistic at the cost of
comparability, since two runs match only where their curves do.
_Avoid_: Profile, ramp, curve

**Baseline**:
The committed reference a run is judged against. Changing it is a deliberate act
that appears in the diff, which is what stops a slow drift from passing as
always-green.
_Avoid_: Target, threshold, SLO

**Scaling ladder**:
The same scenario measured at several voucher counts, to assert the shape of the
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
A program spending a customer's vouchers through the wallet API, holding the key
and the vouchers itself.
_Avoid_: Client, integrator

**Custody**:
Holding either a customer's key or their vouchers. Holding the vouchers alone is
still custody, because vouchers are bearer instruments.
_Avoid_: Storage, hosting

### Buying a voucher with a card

**Purchase**:
A customer buying a voucher with a card, paid to the stall's own Stripe account.
Neither a redemption nor an issuance by hand, so it is counted separately from
both. Recorded as two rows, one in each party's own ledger, never as one shared
record.
_Avoid_: Sale, order, checkout

**Obligation**:
A voucher a stall owes because a purchase was paid. Recorded when payment is
confirmed and discharged only when issuance is confirmed, never when it is
asserted.
_Avoid_: Pending order, debt, IOU

**Purchase Issuer**:
The terminal that mints a voucher when a purchase is paid, holding one credential
per stall. A terminal like any other, so a stall enrols it and burns it the same
way.
_Avoid_: Minting service, bot, robot till

**Connected account**:
The stall's own Stripe account, which is merchant of record for every purchase.
Funds land there and never in an Imani balance, so disputes and reserves are the
stall's.
_Avoid_: Merchant account, Stripe account

**Purchase notice**:
The message telling a stall that a purchase was issued in its name. Carries no
voucher, because the voucher went to the customer; the stall's device turns it
into a ledger row of its own.
_Avoid_: Notification, receipt, webhook

**Stall record**:
The stall's own public description of itself: where it trades, what it sells in,
and whether it takes cards. Plaintext and readable by anyone, so it is what a
stranger knows before they hold anything.
_Avoid_: Profile, merchant record, settings

**Gifting page**:
A stall's public page on gifting.imani.casa, addressed by its handle
(`/shop/alice`), where anyone buys its voucher by card for themselves, a handle
or an email address. Never listed in a directory.
_Avoid_: Shop page, storefront, hexpub link

**Purchase Draft**:
What a gifting-page buyer reviewed, re-checked and pinned by the server before
any card form: the amount and, above all, who receives the voucher. Paying
names the draft and nothing else.
_Avoid_: Cart, order, quote

**Return link**:
The link a guest buyer is given to take an unclaimed gift back. It carries the
gift's refund key, which only the buyer holds; it is never the claim link.
_Avoid_: Refund link, claim link

### Diagnostics

**Support snapshot**:
A point-in-time, pseudonymised copy of what the wallet knows about its own
state, encrypted to Imani support and shared once, for one ticket, after the
customer types the code support gave them and taps Upload now.
_Avoid_: Dump, export, log bundle

**Fleet snapshot**:
A support snapshot built for no ticket: the customer opted in once, and the
support service picked this install at random for a round. Never carries memos
or correlation values, holds at most seven days of history, and is signed only
by the fleet key.
_Avoid_: Telemetry, crash report, sample

**Fleet key**:
A per-install key derived from the customer's key and a random nonce made at
opt-in. The only identity a fleet snapshot or a health check carries, so
support never learns the customer's key. Opting out deletes the nonce, and
opting back in makes a new, unrelated fleet key.
_Avoid_: Device key, client id, telemetry id

**Health check**:
What the customer sees of a fleet snapshot: one line in Snapshot history per
upload, reading sent, received, deleted from server, or not sent.
_Avoid_: Diagnostic, ping, heartbeat

### A note on Stall and Merchant

**Stall** is the word, and everything a customer ever reads says it.

**Merchant** survives on the service side — `imani-merchant`, `merchantPubkey`,
`MerchantStripeAccount` — because Stripe's own vocabulary is merchant-shaped and
renaming across service boundaries would cost more than it returns. Treat it as
the same concept under a foreign name, and do not let it cross back into
customer-facing text.
