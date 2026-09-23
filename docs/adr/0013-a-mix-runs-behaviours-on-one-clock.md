# ADR 0013: A mix runs behaviours on one clock

The load suite measures subsystems. `issuance.js` ramps issuance, `drain.js`
ramps the arrival poll, `receive.js` publishes and drains. Each is isolated on
purpose, so that a regression names its own cause.

Isolation cannot answer whether these actors can coexist. A market has customers
draining, stalls collecting takings, and a Purchase Issuer minting, all at once,
and nothing in the suite has ever run two of them together.

## Decision

A **mix** runs several **behaviours** in one k6 process, on one clock, at the
proportions of a trading day.

Three behaviours, gateway-side:

| Behaviour | Population | Driver |
|---|---|---|
| Customer | 130 | acquire coupons, poll arrivals every 10s |
| Stall | 10 | poll for takings every 10s |
| Purchase Issuer | 1 | poll a debt table every 15s, ~10 purchases/hour |

### Pollers are rate-driven, the crowd is VU-driven

Only the customer population is a crowd, where "how many at once" is the honest
unit. The stall poll and the Purchase Issuer poll are fixed-period processes, and
modelling them as VUs would encode a fiction: their load does not grow because
more people arrived.

They use `constant-arrival-rate`, which holds the rate when latency moves.
`ramping-vus` does not: a VU that is waiting is a VU not applying load, so a
slowing gateway quietly receives *less* work at the moment the measurement
matters most.

### The Purchase Issuer is mostly a heartbeat, and says so

240 polls an hour, about 10 of which find a debt row. That ratio is the
behaviour, not a defect in it.

`loadtest/README.md` records the opposite case as a mistake worth not repeating:
the drain ramp measured 9118 drains against 9118 empty queues and read as a
measurement of receiving. So the mix counts polls that find work separately from
polls that find none, and a run reporting only the total is reporting nothing.

### One process, and what that costs

One clock is the whole point, since contention between behaviours is invisible
across two summaries. The cost is that a regression in a mix names a **suspect,
not a cause**, and the isolated scenarios remain what confirms it. A mix never
replaces them.

## The gateway cannot do half a customer's day

A customer sends coupons to another customer and redeems them at a stall. Neither
is reachable here.

- **Redemption** has no gateway path at all (ADR 0003). It happens on the device.
- **Splitting** likewise (ADR 0004).
- **Sending** cannot originate from a NIP-98 client, because it needs issuance
  through the cookie-gated portal. `receive.js` already stands in for it by
  publishing the envelope through `/internal/v1`, and calls itself a measurement
  of receiving rather than of sending.

So the customer behaviour here is **acquire, poll, receive-by-substitute**, and
the mix's summary says that in its own words. A run that implied it had
reproduced a customer's day would be claiming the two acts it cannot perform.

The send and redemption halves are modelled device-side in `perf/`, which has its
own runner and cannot share k6's clock. The model is defined once and executed in
two places, so contention is measurable **within** the mix and not across the
boundary between the two harnesses. That boundary is a known limit of this
decision rather than an oversight.

## The per-IP rate limit bounds what a mix can claim

Issuance is rate-limited on client IP, and one k6 process is one IP. The README
records 20-40 coupons before `PathRateLimitFilter` refuses, with the window
clearing after about a minute.

A realistic day of issuance for 130 customers is therefore not reachable from a
single load generator against a stack with the limiter at its default. A mix run
either raises the limit for the deployment under test and records that it did, or
reports the limit as the finding. What it must not do is quietly apply a tenth of
the intended load and present the result as a day.

## A shaped day, not a plateau

Load follows the day's curve rather than holding one level, because the question
is realism. The cost is comparability: two runs match only where their curves do,
so a mix is weaker evidence of a regression than a scenario is. That trade is
accepted here and nowhere else in the suite.

## Status

Accepted.

## Consequences

- `CONTEXT.md` gains **Behaviour**, **Mix**, and **Shaped day**.
- A mix is never a gate. It is run deliberately, like everything in `loadtest/`.
- The population figures (130 customers, 10 stalls, 10 purchases/hour) are
  **estimates, not measurements**, and are recorded as such wherever they appear
  so that they do not harden into folklore.
