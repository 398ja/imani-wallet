# 05: Payment requests

**What to build:** `/v1/requests/create`, `/v1/requests/match` and
`/v1/requests/reconcile` — ask a customer for money, and work out later what
arrived against what was asked.

Nearly pure functions over caller-supplied state, so these are the cheapest
endpoints in the spec and among the most useful: this is how an EPOS asks to be
paid. Create is a plan, match and reconcile are attests.

The recipient is always the stall, never the device displaying the request.
`createRequest` already enforces this structurally — it takes an `Actor` and
reads the recipient through `issuingStall`, so there is no field a caller could
put a different key in. The API must not reintroduce one, because takings are
gift-wrapped to the recipient and a request naming a device would strand money
on it.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] A request names the stall as recipient, whatever the caller sends.
- [x] A caller cannot name a different recipient, and the attempt is refused rather than ignored.
- [x] An expired request is reported expired rather than matched.
- [x] A partial payment reports what is still outstanding.
- [x] Two similar requests are not confused: matching is exact, not a heuristic on amount and time.
- [x] A probe creates a request and reconciles a real arrival against it.

## What it took

`@imani/payment-requests`, extracted from `vreq.ts`: `expireRequests`,
`matchPayment`, `groupArrivals` and `partialFor` were already pure and moved
unchanged. All 35 existing vreq tests pass untouched.

**The encoder was the interesting part.** `createRequest` reaches
`window.NUT18V`, and `shared/nut18v.js` is a classic script — an IIFE that
assigns `window` and exports nothing. Reimplementing it was never an option:
`vreqA` is CBOR in URL-safe base64 that must match `VoucherPaymentRequest.java`
byte for byte, and a request encoded slightly differently would scan, look
right, and be refused by the gateway — or worse, be accepted carrying a field
the payer did not intend.

So the service loads the SAME FILE through a VM context with the globals it
actually reaches. Verified by decoding a request the API produced with the same
encoder and reading back the issuer, amount and single-use flag.

**One endpoint, not two.** `/v1/requests/match` and `/v1/requests/reconcile`
resolve to the same handler, because matching one arrival is the same
computation as reconciling a day of them, and two endpoints would be two
chances to disagree about which payment settled which request.

`bundleId` and `paymentId` were added to `ReportTransaction` — needed by
`groupArrivals`, which sums the parts of one logical send, since a customer
paying £10 as three coupons has paid once.

## Evidence

21 endpoint tests and a 13-check probe against the running service.

The security property is narrow and absolute, so it is tested four ways and
probed three: a caller sending `issuerId`, `recipientPubkey`, `stallPubkey` or
`recipient` is REFUSED rather than having it ignored — an integrator should
learn this at the first request, not after a day of takings have gone somewhere
unreachable.

Mutation control: emptying the forbidden-field list fails exactly those four
tests.

Two behaviours worth naming, both probed live:
- a payment that FALLS SHORT does not settle the request, and reports what
  arrived. Going the other way costs a merchant real money, by handing over
  goods against a part payment.
- `direction` is derived from `type`, so a caller marking its own send as
  incoming cannot settle its own request and mark itself paid.
