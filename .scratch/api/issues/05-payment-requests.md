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

**Status:** todo

- [ ] A request names the stall as recipient, whatever the caller sends.
- [ ] A caller cannot name a different recipient, and the attempt is refused rather than ignored.
- [ ] An expired request is reported expired rather than matched.
- [ ] A partial payment reports what is still outstanding.
- [ ] Two similar requests are not confused: matching is exact, not a heuristic on amount and time.
- [ ] A probe creates a request, pays it for real, and matches the arrival.
