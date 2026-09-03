# Redemption is not load tested

The performance suite exercises issuance, send, split and notification drain
against the gateway. It leaves **redemption** alone, and that gap is deliberate.

Redemption is a customer returning a stall's coupons to the stall that issued
them. It is the ordinary end of a coupon's life, and the one flow that must
never need the network to authorise it: a stall honours its own coupons from
what the customer presents, offline, with no gateway in the path.

The obvious alternative was to load test it like every other flow, and it is the
flow that most deserves the attention, being both the most frequent and the most
important. We rejected it because there is no gateway path to measure. Building
a load test for redemption means first building the network call it would
exercise, which would install exactly the dependency the design exists to avoid.
A green load test on that call would then read as evidence the flow is healthy,
while measuring a path no correct client takes.

The risk this accepts is that redemption's cost on the device goes unmeasured by
the backend suite. That is covered on the browser side instead, where the work
actually happens: coupon selection and the spend plan are measured against a
wallet holding a large coupon set, with no gateway involved.

**That cover now exists** (#26). `perf/scenarios/redemptionPlan.ts` reads the
wallet and builds a spend plan across five rungs from 5 to 500 coupons, with the
browser context set OFFLINE — so the claim that redemption needs no network is
established by removing the network, not by asserting it.

Measured: cost is **linear** in the number of coupons held, 0.100ms per coupon at
50 and 0.098ms at 500. The flow that has to work when nothing else does does not
degrade as a wallet fills.

Two things the measurement found, recorded here because they are properties of
the design rather than of the test:

- **The cost is the storage read, not the search.** Reading 500 coupons out of
  IndexedDB takes ~50ms; the plan itself takes ~600 microseconds.
- **Stopping early saves almost nothing.** `planParts` filters and sorts the
  whole wallet before walking any of it, so an amount covered by the first
  coupon costs what an unreachable one costs. Selection cost is the sort.

## Consequences

- A reader finding no redemption scenario should not add one. The absence is the
  decision, and this file is the reason.
- Redemption performance regressions surface in the browser fork, not the
  backend fork — specifically in the `redemption-plan` scenario and its
  committed baselines. If that coverage is dropped, redemption becomes
  unmeasured entirely, and this ADR should be revisited rather than quietly
  outlived.
- Should redemption ever gain a network path, this decision is void and the flow
  needs load testing like any other. The presence of such a path is itself the
  signal to revisit.
