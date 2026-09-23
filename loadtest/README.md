# Gateway load testing

Measures the service under load. Needs a real deployment, and because staging
is shared and single-host, a run cannot gate anything: two runs collide and
neither is reproducible. An operator runs this deliberately.

The device-side counterpart lives in [`perf/`](../perf/README.md), and the
decisions common to both are recorded there.

## The signer

    node loadtest/signer.mjs          # 12 workers on 127.0.0.1:8765
    node loadtest/signer-check.mjs    # prove it before trusting a run

Signing happens in a sidecar process rather than inside the load generator.
This is settled by measurement, not preference: the retired imani-apps project
measured in-engine signing at **p99 676ms**, about 67x over its budget, and the
same work in a Node sidecar at **p99 61ms, 2401 req/s**. Both results are in
that repo's `loadtest/spike-0/` and `spike-0b/`. Re-running the failed
experiment to rediscover the same answer is the most predictable waste
available here.

`signer-check.mjs` asks three things, in this order:

1. **Is every signature valid?** First, because a signer that is fast and wrong
   fails every request at the gateway, and the run then reads as a gateway
   problem. Verified against locally derived public keys, and `derivePub` is
   checked separately so a signer signing with the wrong key cannot pass.
2. **Does it sustain the rate a ramp demands?** Gated at 250/s, ten times the
   ~25/s that 50 customers signing twice per iteration actually need.
3. **What share of an iteration does signing cost?** Reported per scenario, so
   the moment the run starts measuring the load generator is visible rather
   than inferred.

### Reading its latency correctly

The checker and the signer share one machine, so they compete for cores.
Throughput *falls* as workers rise, measured on a 12-core laptop:

| Workers | Throughput | p99 |
|---|---|---|
| 2 | 412/s | 62ms |
| 4 | 394/s | 68ms |
| 8 | 374/s | 72ms |
| 12 | 371/s | 76ms |

More workers is worse because each takes a core the checker needed. A single
signature costs about **2ms of CPU** measured directly, so twelve cores could
produce several thousand a second; nothing near that appears here because the
*client* is the constraint.

So these numbers are a floor on the signer and a ceiling on the checker. Under
a real run the load generator is the busy party and the signer has cores to
itself. Quoting the checker's latency as the signer's cost would be the same
error as quoting a laptop figure as production capacity.

## The helper library

    loadtest/lib/signed-request.js   NIP-98 signing, via the sidecar
    loadtest/lib/gateway.js          the calls the wallet makes
    loadtest/lib/metrics.js          what a run measures
    loadtest/smoke.js                prove it all works, at one customer

Ported from the retired imani-apps project and renamed on the way in: it spoke
of vouchers, merchants and users, all of which this repository's `CONTEXT.md`
lists under terms to avoid. Since that project is retired and nothing will be
merged back, preserving a comparable diff has no value, and a port is the one
moment renaming is free.

Request bodies match what the wallet sends, read from `src/lib/issue.ts` and
`src/lib/incomingNotifications.ts` rather than from the old scripts.

**One deliberate divergence: the signature carries a nonce, and the wallet's
does not.** This was removed first, on the principle of matching the wallet
exactly, and that was wrong. The event id hashes the tags and a
second-granularity timestamp, so two identical requests in the same second
produce the same id and the gateway rejects the second:

    nip98_eventid_replay_detected ... reason=Event ID already used

The wallet never hits this because it never repeats a request within a second;
it drains every ten. A load run does so constantly. imani-apps carried a nonce
for exactly this reason.

### Which tier serves what

Verified against this stack, because a 404 here reads as "the endpoint does not
exist" when it means "it is on the other tier":

| Call | Tier | Evidence |
|---|---|---|
| Issue a coupon | portal `:28084` | 201 with `X-Auth-Permissions: coupon:issue` |
| Send coupons | account `:28081` | `/api/v1/atomic-send`; `:28082` answers 404 |
| Drain arrivals | account `:28081` | 401 there, 404 on `:28082` |
| **Split a coupon** | **none** | refused by design, see below |

**Splitting has no gateway path**, recorded in
[ADR 0004](../docs/adr/0004-splitting-is-not-load-tested.md). The customer
gateway refuses it outright: *"Voucher split execution is not supported on
JdbcWalletPort — the customer-wallet is self-custodial (Constitution Principle
II)."* Same case as redemption in ADR 0003: the work happens on the device, so
measuring it belongs in the browser suite. `splitCoupon()` is exported and
throws with that explanation, so anyone looking for a split scenario finds the
reason rather than an absence.

### The smoke run

    node loadtest/signer.mjs &
    GATEWAY_URL=http://localhost:28082 PORTAL_URL=http://localhost:28084 \
      k6 run loadtest/smoke.js

Every full run starts with this. imani-apps' first two real runs each spent
fifteen minutes discovering bugs in the *scripts* rather than anything about
the system; one customer and three iterations catches that in seconds.

Verified to fail when it should, which is what makes a pass mean anything:

| Situation | Result |
|---|---|
| Everything working | 9 checks passed, exit 0 |
| Signer not running | exit 107, names the command to start it |
| Gateway unreachable | exit 99, 6 checks failed, thresholds crossed |
| No checks ran at all | reported explicitly, since `rate==1.0` is vacuously true against nothing |

### Reading the signing share

Every run reports what fraction of an iteration was spent signing, because the
sidecar is fast but not free and a run whose iterations are mostly signing has
stopped measuring the gateway.

The share is only judged once iterations are doing real work (500ms or more). A
smoke run is ~78% signing by construction: it makes two trivial calls, so
almost all of its time is signature overhead. Warning about that would be noise
that teaches people to ignore the warning when it matters, so the number is
printed and the conclusion withheld.

## The receive ramp

    INTERNAL_URL=http://gateway-core:8081 \
    SERVICE_ID=loadtest SERVICE_TOKEN=... \
    ACCOUNT_URL=http://localhost:28081 k6 run loadtest/receive.js

The drain ramp measures the endpoint against an **empty** queue — on staging,
9118 drains and 9118 empty. That is a real measurement of the poll the wallet
makes every ten seconds, and it is not a measurement of receiving anything. The
work that scales with load — matching a selector against a populated queue,
serialising envelopes, acknowledging them — was unmeasured.

This ramp publishes a real envelope for a real recipient, drains it, and
asserts **that** envelope came back. A queue quietly returning stale entries
under load would otherwise read as healthy.

`arrival_to_drain_ms` is the number to watch: enqueue to the recipient holding
it. imani-apps' plan set a receive SLO of 99% inbound-to-redeemed within 8s;
this measures the gateway's share of that budget, so it is a floor under the
SLO rather than the SLO itself.

### It substitutes for the send, and says so

A real arrival originates in the atomic-send saga, which needs a coupon, which
needs issuance, which needs the portal — and the portal is gated behind a
session cookie a NIP-98 client cannot obtain. So this publishes the same
envelope the saga publishes, through the same service method, onto the same
queue, via `POST /internal/v1/incoming-notifications/publish`.

That makes it an honest measurement of **receiving** and a stand-in for
**sending**. A green run says the recipient side holds up under arrival load.
It says nothing about whether sends keep up.

### Why it cannot run from your laptop

`/internal/v1` is not reachable from outside the deployment: nginx declares
`/internal` as an internal location, so the public edge answers 405 to a POST.
That is the intended posture — the endpoint takes its recipient from the
**body**, so a user credential reaching it would let any user enqueue for any
other, and the controller says as much.

So `INTERNAL_URL` has to point inside: `http://gateway-core:8081` on the
deployment host, or a local stack. Note 8081, not 8080 — the actuator is on a
separate management port, and 8080 answers nothing.

It also needs a service credential (`X-Service-Id` + `X-Service-Token`),
bcrypt-checked against `service_credentials` and row-scoped to this one path,
so a leaked token buys the ability to enqueue notifications and nothing else.
Staging provisions it as `GATEWAY_CORE_SVC_CRED_CUSTOMER_WALLET`, bcrypted into
`service_credentials` at boot. Until 2026-09-16 staging provisioned **no**
credentials at all and customer-wallet had no allowlist entry for this path, so
the two failures hid each other.

**2026-09-16:** 897 published, 897 matched, 0 unmatched, 2691/2691 checks.
Arrival to drain **avg 246ms, p95 258ms** — the gateway's share of the 8s
inbound-to-redeemed budget.

The first attempt at this run measured something else entirely. Publishes were
answering 429 because `/internal/v1` service-to-service calls were rate-limited
as ANONYMOUS at 60/min per address, and every internal caller shared that one
bucket — 179 of 263 refused, while gateway-core logged no refusal of its own
because the limiter rejected them before the controller ran. Fixed in
imani-security 5c7e331; the same ramp then published 4.8x as much with nothing
refused.

### Keep MAX_VUS low over a tunnel

The ceiling defaults to 5, lower than the other ramps, because an SSH tunnel
multiplexes every VU onto one connection and saturates long before the service
does. Measured at 20 VUs: 4192 of 4432 publishes never left the laptop while
gateway-core logged 241 arrivals and no errors at all. That is the load
generator being the bottleneck, and the summary now says so rather than leaving
it to be inferred from a latency number that describes the tunnel.

Raise it only when running where the service is, with `INTERNAL_URL` pointed at
the container directly.

Every failure mode was exercised rather than assumed:

| Situation | Result |
|---|---|
| No `INTERNAL_URL`, run from a laptop | names the internal-location design and both correct URLs |
| Pointed at the public edge | explains the 405 is the edge, not the service |
| No credential | names the headers and the table, and does not retry |
| Signer not running | exit 107, names the command |

## The customer pool

    node loadtest/pool.mjs --size 50            # create, or top up to 50
    node loadtest/pool.mjs --size 50 --verify   # and check each is usable

Customers are named by position (`loadtest-customer-0000`), so the same index
is the same customer on every run. That is what makes topping up possible, and
it lets a scenario pair customer N with customer M reproducibly.

Running it again **tops up rather than rebuilds**, which matters beyond
convenience: rebuilding would orphan the coupons previous runs issued, under
keys nothing references any more. The pool accumulates value across runs,
since issuance is what funds sending, splitting and draining.

| Command | Result |
|---|---|
| `--size 10` on an empty pool | added 10, total 10 |
| `--size 10` again | added 0, "already had 10" |
| `--size 25` | added 15, total 25, **customer 0000 keeps its key** |
| `--size 5 --verify` against a live gateway | 5/5 usable, exit 0 |
| `--verify` against a dead gateway | 0/3 usable, exit 1 |

Keys land in `.loadtest-pool.json`, which git ignores. They are throwaway
identities on a test deployment and worth nothing, but they are still keys.

## The issuance ramp

    node loadtest/signer.mjs &
    node loadtest/pool.mjs --size 50
    GATEWAY_URL=http://localhost:28082 PORTAL_URL=http://localhost:28084 \
      EDGE_SECRET=dev-edge-secret-local-only \
      k6 run loadtest/issuance.js

Issuance goes first because it produces the coupons that sending, splitting and
draining all consume. It is both the first measurement and the tool that funds
everything after it.

**No latency threshold, on purpose.** This is capacity discovery: the output is
a report saying where the deployment degraded. Inventing a pass mark before a
baseline exists would produce a number nobody could defend. The only thresholds
are correctness ones.

### The first finding

The gateway rate-limits issuance, keyed on **client IP**, so every customer in
the pool shares one budget. On this stack a run issues 20-40 coupons before
`PathRateLimitFilter` starts refusing, and the window clears after about a
minute.

That is the answer to "where does this break first", and it is reported as a
finding rather than as failures.

### Why the script has to infer throttling

`gateway-customer` returns a proper `429` with a `RATE_001` body. `gateway-portal`
catches it and re-emits a bare `500 {"error":"Internal server error"}`, so
**nothing a caller receives says "rate limited"**. Filed as #37.

Until that is fixed, the script issues one coupon before applying load, and
then reads later opaque 500s as throttling. The inference is only sound because
the pre-run probe established the endpoint works; if it did not, failures are
reported as failures, which is the safe way round. A genuine outage must not be
excused as a rate limit.

That probe retries for up to a minute, because a previous run can leave the
window saturated. Without the retry, two runs back to back reported **12660
failures** and **0** respectively for a deployment that was healthy both times.

## Aborting a run whose data is already invalid

    node loadtest/abort-watch.mjs &                     # watch, serve on :8766
    node loadtest/abort-watch.mjs --check               # one pass, then exit

    ABORT_WATCHER_URL=http://127.0.0.1:8766 k6 run loadtest/issuance.js

A run that keeps going after a subsystem has failed generates data that is
already invalid, and buries the moment things went wrong under minutes of
consequences.

### Observed signals, and unproven ones

Every pattern is marked `observed` or `unproven`, and that distinction is the
whole point.

imani-apps' plan predicted a connection pool would fail with `Connection is not
available, request timed out`. Under load it failed with `HikariDataSource has
been closed` — a *closed* pool, not a timeout waiting for a slot. Its own run
report records "Hikari `Connection is not available`: **0 observations**". The
predicted signal never fired while the run produced hours of worthless data.

| Signal | Confidence | Evidence |
|---|---|---|
| `HikariDataSource has been closed` | observed | 316 in imani-apps run 002 |
| `relay_subscription_failed` | observed | 332, starting ~564ms before the pool closures |
| `proof_repository persist_failed` | observed | 243, downstream of the closed pool |
| `check_pending_voucher_failed` | observed | 117 |
| `Connection is not available` | **unproven** | predicted, 0 observations |
| `proofs_not_bound` | **unproven** | never seen |

Adding a pattern is cheap. *Believing* an unproven one is what costs a run.

### Two kinds of invalid

A **subsystem failure** means the deployment is unwell: the run found something
and should stop before recording the consequences.

**Load generator saturation** means this machine ran out of capacity before the
gateway did, so the numbers describe the laptop. That is not a gateway capacity
finding, and the two are easy to confuse because the graphs look alike.

**Rate limiting is deliberately not an abort signal.** It is the deployment
defending itself, and aborting on it would end every issuance run at the moment
it discovered what it went looking for.

### Demonstrated, not merely implemented

| Case | Result |
|---|---|
| A signal that is present | k6 exits **108**, `test aborted: SUBSYSTEM FAILED: … (observed)` |
| Healthy stack, watcher live | 39 issued, 0 failed, exit 0, no spurious abort |
| No watcher configured | run proceeds unchanged |
| Watching staging (no local containers) | no breach, since there is nothing to read |

Abort logic that has never been seen to fire is indistinguishable from none.

## The send ramp

    ACCOUNT_URL=http://localhost:28081 k6 run loadtest/send.js

Each iteration issues a coupon, waits for the mint to back it, then sends it to
another customer. Sender and recipient are paired by position, so the pairing
is the same on every run.

That makes a send run **bounded by the issuance rate limit as well as by the
send path**, which is honest rather than convenient: coupons are bearer
instruments, so a pre-funded pool would mean holding real tokens in a file
between runs, and a run that crashed mid-send would strand value in a JSON blob
nobody reads.

`not backed` is counted separately from failures. A coupon is not sendable the
instant it is created; the token appears once the mint has backed it. Counting
that as a send failure would blame the send path for the mint's latency.

### The wire format is snake_case

The wallet's `buildSendParams` uses camelCase and its client layer converts.
Copying the wallet's field names verbatim sends `recipientPubkey`, and the
gateway answers:

    VALIDATION_001 field_errors:[{field:"recipientPubkey",
                                  message:"Recipient pubkey is required"}]

It names the field using the name it was *given*, so a misspelling reads as an
absence. The mapping that matters is imani-apps' `shared/api.js`
`initiateAtomicSend`, not the wallet's TypeScript.

`face_value` is the **send amount**, not the coupon's face value. `pay.ts`
records why: passing the coupon's value made a partial send complete as a full
one, the recipient got the whole coupon, and the customer got no change.

## The drain ramp

    ACCOUNT_URL=http://localhost:28081 k6 run loadtest/drain.js

The gateway-side counterpart to the browser drain scenario: this measures the
service, that one measures the device. Draining is a read, so it needs nothing
issued first, which makes it the scenario that can push hardest.

On this stack: **6609 drains, 0 failed, avg 22ms, p95 33ms**, no rate limiting
reached.

### What it does not measure here

Every drain comes back **empty**, so what is measured is the cost of answering
"nothing waiting" — the endpoint, the signature check and the queue poll, but
not the work of returning and acknowledging envelopes.

Envelopes are payment *receipts* delivered over Artemis. Coupon sends do not
produce them, so running the send ramp first does not help: measured, **10
sends produced 0 envelopes**. Populating that queue needs the payment flow,
which no scenario here drives yet.

The summary says this explicitly whenever it happens, because an all-empty run
looks identical to a healthy loaded one in every other number. A scenario that
quietly measured nothing while reporting a clean p95 would be worse than none.

## The stalls

    node loadtest/stalls.mjs --count 10            # enrol, or top up
    node loadtest/stalls.mjs --count 10 --verify   # and prove each can issue

A pool identity is a **customer**: its NAP session carries
`coupon:pay,coupon:receive`, and the portal answers `403` to any attempt to
issue. That is correct, and it is why the market day's acquiring half reported
zero coupons for its first several runs.

A **stall** is not a different kind of account. It is a key that has published a
**stall record**: a kind-30078 addressable event tagged `d=imani:merchant`, the
same one a stall owner's phone writes when they set up their business.
gateway-core derives the session's role from it, and the session then carries
`coupon:issue,coupon:pay,coupon:redeem,coupon:receive`.

So this script does by hand exactly what the app does, for the pool's first
`--count` identities, which are the same ones `market-day.js` uses as stalls.

**The ACL is not immediate.** Publishing is not enough on its own: the record
has to reach the gateway and the ACL has to resolve it. Measured on staging, a
session opened ~5s after publishing still carried customer permissions, while
~60s later the same key could issue. So the script **polls** rather than
sleeping a guessed interval, and reports how long each stall took.

| Command | Result |
|---|---|
| `--count 3` on a fresh pool | 2 published, both trading after ~60s |
| `--count 3` again | "nothing to do; every stall can already issue" |
| `--count 3 --verify` | **3/3 stalls issue**, each proven with a real 201 |

`--verify` issues a real coupon rather than trusting the permission string,
because the two came apart once already on this stack: a registry image granted
a flat role while the portal refused every merchant anyway.

### Why not a terminal credential

That was tried first and was the wrong tool. A terminal (ADR 0005) is how a
**second device** gains authority to act for a stall that already exists, which
is a different problem from making a stall exist. It needs a mint quote staging
currently answers with `mint_error_code=90008`, and terminal enrolment is not
wired to any screen yet (`.scratch/terminals/OUTSTANDING.md`).

An owner selling from their own phone mints no terminal credential. Neither does
this.

## The market day

    node loadtest/signer.mjs &
    node loadtest/pool.mjs --size 140
    node loadtest/stalls.mjs --count 10 --verify
    GATEWAY_URL=http://localhost:28082 PORTAL_URL=http://localhost:28084 \
      ACCOUNT_URL=http://localhost:28081 \
      EDGE_SECRET=dev-edge-secret-local-only \
      k6 run loadtest/market-day.js

Everything above this heading is a **scenario**: one subsystem, isolated, so a
regression names its own cause. This is a **mix**, and it is the only file here
that gives that up. Settled in
[ADR 0013](../docs/adr/0013-a-mix-runs-behaviours-on-one-clock.md).

Three **behaviours** run together on one clock, because contention between them
is invisible across two summaries:

| Behaviour | Population | What it does | Executor |
|---|---|---|---|
| Customer | 130 at peak | buys from a stall on arrival, then polls every 10s | `ramping-vus` |
| Stall | 10, all day | polls for takings every 10s | `constant-arrival-rate` |
| Purchase Issuer | 1 | polls `/api/v1/purchases/owed` every 15s | `constant-arrival-rate` |

### A sale is three stages, not one request

`src/lib/issue.ts` is the authority, and the mix follows it:

1. `POST /api/v1/portal/vouchers` on the session, which returns a voucher id
2. **poll** `/api/v1/wallet/vouchers/{id}` every 2s until `ISSUED` with a token,
   up to 30 times
3. `POST /api/v1/dm/tokens/send`, delivering the coupon as a gift-wrapped DM

The first cut did step 1 alone and counted the sale. That measured roughly a
tenth of the work and minted coupons **no customer ever held**. Measured against
staging, the mint wait is the bulk of a sale: **~6s at 2.2 polls**, against a
~900ms POST.

Note the tier change in step 2: the poll is on the **wallet** tier with NIP-98,
not the portal with the session cookie. Polling the portal returns nothing
useful and the loop runs its whole budget, measured as 30 polls over 67s with no
status at all.

The summary counts **minted** and **delivered** separately, and treats delivery
as the outcome. A coupon that minted and never reached anyone is the failure
most likely to read as success, because the 201 already happened.

### This is the first scenario whose queues are not empty

Delivering a real coupon is what puts an envelope on the recipient's queue. Every
other scenario here measures drains against an **empty** one and says so;
`receive.js` escapes it only by publishing through `/internal/v1`, which is not
reachable from outside a deployment.

A run that delivers needs no such workaround, so the mix measures the work of
returning and acknowledging envelopes rather than the cost of answering "nothing
waiting". It says which of the two it did, per run, rather than assuming.

**The drain response field is `envelopes`.** The mix read `notifications` at
first, which would have counted zero however full the queue was, and that is
invisible by construction: it looks exactly like a healthy run against an empty
queue. `envelopesFrom` is now the one place that knows the shape.

### A hidden tab does not poll

The wallet **pauses** its drain loop while the tab is hidden, and runs a catch-up
tick on `visibilitychange`. `incomingNotifications.ts` explains why: every tick
is a signature, a round trip and a gateway thread, and a background tab has no
toast to show for it. Staging logged one forgotten client draining 119 times in
20 minutes.

So a model where all 130 customers poll forever **invents traffic the deployment
will never see**. `HIDDEN_SHARE` defaults to 30%, decided per VU rather than per
iteration, because a customer who pockets their phone stays pocketed.

Every customer also does a **boot tick**: `startIncomingNotifications` drains
immediately on login so anything already queued surfaces without a ten-second
wait. A crowd arriving together makes that a burst, and a model that waits a full
period understates it.

The first cut of the hidden share was `id % 100 < share * 100`, which is correct
only at scale: VU ids 1 to 4 are all below 30, so a four-customer run hid **all**
of them and collapsed customer drains to the boot tick alone. Now hashed, and
verified at 32% of 130 VUs and 1 of 4.

### Why only the crowd is VUs

A VU is the honest unit for customers, where the question really is how many
people are in the market at once. It is the wrong unit for the two pollers: a
stall's takings poll does not speed up because more customers arrived, and the
Purchase Issuer is one process on a fixed period.

`constant-arrival-rate` also **holds the rate when latency moves**, and
`ramping-vus` does not. A VU that is waiting is a VU not applying load, so a
VU-driven poller quietly reduces its load exactly when the gateway slows, which
is the moment the measurement matters most.

### It is the gateway's share of a day, not a day

A customer acquires, receives, **sends**, and **redeems**. The last two are not
reachable from here at all:

| Act | Why not |
|---|---|
| Redemption | no gateway path, ADR 0003. It happens on the device |
| Splitting | likewise, ADR 0004 |
| Sending | the escrowed saga needs coupons in a customer's own wallet, which the gateway does not hold |

So a customer here **acquires and polls**, and the summary says so on every run
rather than only when something looks wrong. The send and redemption halves are
modelled device-side in [`perf/`](../perf/README.md), which has its own runner
and cannot share k6's clock. The model is defined once and executed in two
places, so contention is measurable *within* the mix and not across the boundary
between the two harnesses.

### The rate limit is the finding, not a failure

Issuance is limited per **client IP**, and one k6 process is one IP, so the whole
crowd shares one budget. A realistic day of issuance for 130 customers is
therefore not reachable from a single load generator against a default stack.

This run **reports the limit rather than raising it**, so the summary names how
much less issuance load the day applied than it intended. What it must never do
is apply a tenth of the intended load and present the result as a day.

### Its drain numbers may not be comparable with `drain.js`

That ramp measures an **empty** queue. When the mix has delivered coupons, its
queues hold what the day put in them, so the per-poll cost is higher by
construction and quoting one against the other would read as a regression in a
scenario that did not change.

When nothing was delivered, the two **are** comparable, because both measured
the same empty queue. The summary says which of the two this run did rather than
leaving it to be inferred.

### The populations are estimates

130 customers, 10 stalls, 10 purchases an hour. Nobody measured a market to get
these. They are recorded as estimates so they do not harden into folklore, and
every one is an env knob: `CUSTOMER_PEAK`, `STALL_COUNT`, `COUPONS_PER_CUSTOMER`,
`CUSTOMER_POLL_SECONDS`, `STALL_POLL_SECONDS`, `ISSUER_POLL_SECONDS`,
`HIDDEN_SHARE`.

`HIDDEN_SHARE` deserves naming twice: nobody measured how many market-goers
leave the tab open, and it scales drain load directly.

The values NOT estimated are the ones read from the client source, and they are
marked as such where they appear: the 10s drain period, the 2s mint poll and its
30-attempt budget, and the three stages of a sale.

### The day's shape

A **shaped day** rather than a plateau, because the question is realism: opens at
20% of peak, builds through the morning, a third of the day at peak, then falls
to 30% by close. The cost is comparability, since two runs match only where their
curves do, which makes a mix weaker evidence of a regression than a scenario is.

Both axes are fractions, so `DAY_DURATION` scales the whole curve. That is what
makes a short run possible:

    DAY_DURATION=40s CUSTOMER_PEAK=6 STALL_COUNT=2 k6 run loadtest/market-day.js

The first version wrote the stages as `18m`, which pinned the crowd to a real
hour while `DAY_DURATION` shortened only the pollers. Nobody would ever have
smoke-tested a file that costs an hour to try, so this was found by trying it.

Every failure mode was exercised rather than assumed, against a stub gateway:

| Situation | Result |
|---|---|
| Everything working | 126 checks passed, per-behaviour latencies reported separately |
| Gateway unreachable | exit 107, "did not answer; is the stack up?" |
| Pool too small for the stalls asked for | names the `pool.mjs --size` to run |
| `PURCHASE_API_URL` unset | issuer reported **NOT MEASURED**, not as zero polls |
| Stalls hold no `coupon:issue` | degrades: polls still run, and the summary names `stalls.mjs` |

That last one matters more than it looks. A counter at zero reads identically
for "polled and found nothing" and "never ran", and only one of those is a
measurement.

### It ran against staging, and now acquires there too

The first runs reported **0 coupons acquired**, and the reason recorded for it
was wrong (see [what can and cannot be run against staging](#what-can-and-cannot-be-run-against-staging)).
With the stalls enrolled, a 90s run at 4 customers and 2 stalls acquired **4
coupons, 92 checks, 0 failed** against staging.

The mix also had **customers issuing to themselves**, which is not a thing that
happens: a customer acquires a coupon because a stall issued one. Stalls now
issue, spread across the pool's stalls by VU so the crowd does not queue behind
one of them.

### It found a bug in itself

[`results/staging-2026-09-23-market-day.md`](results/staging-2026-09-23-market-day.md).

The stalls' poll rate was polls-per-**second**, rounded: two stalls on a ten
second period became `max(1, round(0.2))` = one per second, **five times** the
intended load. It was correct at the default of ten stalls, so only a run that
varied the count could have found it.

The same run also found that **~17% of authenticated drains cost 2.2s** against
a 140ms median, a step rather than a tail. Warm-up, contention between
behaviours, error paths, the network, the signer and pacing alone were each
tested and ruled out, and `drain.js` at 958 drains shows no step at all. It is
recorded as unexplained rather than guessed at, and the summary now names the
shape so nobody reads that p95 as load.

## What can and cannot be run against staging

Every tier answers on **`wallet.staging.398ja.xyz`**, routed by path.
`customer.staging.398ja.xyz` is a retired name that nginx now 404s
deliberately, so a run that predates this and relies on the old default fails
against a host that no longer exists.

| Scenario | Staging | Why |
|---|---|---|
| `smoke.js` | yes | NIP-98 only |
| `drain.js` | yes, but throttled | see below |
| `issuance.js` | **no** | signs NIP-98 only, which cannot carry `coupon:issue` |
| `send.js` | **no** | needs issuance |
| `market-day.js` | **yes, fully** | once `stalls.mjs` has enrolled the stalls |

Staging runs `nap_auth.lua` in front of `/api/v1/portal/`, and that gate clears
any client-supplied `X-Edge-Auth` / `X-Auth-Permissions` before demanding a
session cookie. That is correct and should stay: those headers are the only
thing standing between a customer and `coupon:issue`.

**A script CAN obtain that cookie**, and this README said otherwise until
2026-09-23. `POST /auth/init {npub}` returns a challenge, a kind-27235 event
signs it, and `POST /auth/complete` sets the session. That is the wallet's own
login performed without a browser, and `loadtest/lib/signed-request.js`
now does it (`napLogin`).

What actually blocks `issuance.js` is **authorisation**, one layer further in.
It signs NIP-98, and `Nip98AuthFilter` grants only `ROLE_NOSTR_USER`:
`coupon:issue` comes solely from `NapProxyAuthFilter`, on the session path. So
no amount of per-request signing reaches it, whatever key signs. `market-day.js`
takes the session path instead and issues fine. See
[the market day](#the-market-day) below.

A gateway-side run from one host is also bounded by a blanket **100
requests/minute per caller address**, not per pubkey. A 21-VU drain ramp took
2083 rejections against 241 successes because the whole pool is one address.
Until that is keyed on the authenticated pubkey, no single-host run can find
the deployment's real ceiling. Recorded with evidence in
[`results/staging-2026-09-16.md`](results/staging-2026-09-16.md).

## Checking the stack before a run

    ./deploy/up.sh && ./deploy/check.sh

`docker ps` will not tell you the stack is healthy: a container that exited is
simply absent from the list, so counting running containers reports a complete
stack while a service is dead. That is how `account-app` sat exited through a
whole evening of load runs.

`check.sh` names every expected service, so a missing one is a failure rather
than a shorter list. It also reaches past `gateway-customer`'s healthcheck,
which reports `OUT_OF_SERVICE` while serving perfectly (see the note in
`up.sh`), to ask whether the service actually answers a request.

Exercised against the failure modes that matter:

| Situation | Result |
|---|---|
| Everything up | `Stack is ready`, exit 0 |
| A service stopped | names it `NOT RUNNING`, exit 1 |
| A service exits after starting | caught, exit 1 |
| A database killed under a running service | caught via the database, exit 1 |
| Run from another directory | works, exit 0 |
| Required local image missing | `up.sh` names the image and the `mvn` command, exit 1 |
| `DEPLOY` pointing nowhere | names the directory, not the env file inside it, exit 1 |
