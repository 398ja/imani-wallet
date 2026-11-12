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
      EDGE_SECRET=dev-edge-secret-local-only-32-plus-chars \
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
      EDGE_SECRET=dev-edge-secret-local-only-32-plus-chars \
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

### A day that did not deliver now fails

The 2026-11-06 staging run passed while gateway-customer was out of heap
(imani-gateway-customer#298): the voucher poll answered 730 × 499 and 141 × 504,
and only 18 of ~100 sales were delivered. `outcome_verified` could not see it,
because it pools sales with drains and drains outnumber sales a hundred to one.
The sale loop also filed a sale whose polls all failed as **rate limited**, so it
never counted as a failure at all.

Two thresholds now watch the sales on their own:

| Threshold | Gate | What it catches |
|---|---|---|
| `sale_delivered` | `rate>0.95` | coupons delivered over sales attempted, rate-limited sales included |
| `http_req_failed{name:read coupon}` | `rate<0.05` | the voucher poll answering 4xx, 5xx or nothing (k6 status 0) |

Both pass vacuously when acquiring is refused in setup, which the summary
already reports as its own finding. The summary ends with a **Gates** block that
says which thresholds failed, since it replaces the k6 summary where the
threshold table normally appears.

Proven against a stub gateway (`loadtest/stub/market-day-gateway.mjs`, which
answers only the calls a market day makes and checks no signature):

    node loadtest/signer.mjs &
    node loadtest/stub/market-day-gateway.mjs &               # or BROKEN=504, BROKEN=hang
    GATEWAY_URL=http://127.0.0.1:18082 DAY_DURATION=40s CUSTOMER_PEAK=6 STALL_COUNT=2 \
      MINT_POLL_SECONDS=0.5 MINT_POLL_ATTEMPTS=6 k6 run loadtest/market-day.js

| Stub | Before | After |
|---|---|---|
| healthy | exit 0 | exit 0, 6 of 6 sales delivered, all thresholds held |
| `BROKEN=504`, every voucher poll 504s | **exit 0**, 0 delivered | exit 99, `sale_delivered` and `http_req_failed{name:read coupon}` crossed |
| `BROKEN=hang`, every voucher poll times out | not run | exit 99, both crossed, plus `outcome_verified` |

The "before" row is the point: the unchanged script passed a day that delivered
nothing.

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

## A real market day (#550)

    node loadtest/signer.mjs &                         # the k6 crowd signs through it
    node loadtest/pool.mjs --size 120                  # 10 pool stalls reserved + 100 customers
    node loadtest/stalls.mjs --count 10 --verify       # the pool stalls trade
    npx tsx loadtest/real-day.mts --dry-run            # pool, keys, pubkeys, env, then exit
    npx tsx loadtest/real-day.mts --smoke              # corda + bart + 3 customers, every journey once
    npx tsx loadtest/real-day.mts                      # 100 customers + 10 stalls, 20 minutes

`market-day.js` alone is the gateway's share of a day. This is the day: the **deployed wallet**
(`E2E_BASE`, default staging) driven through every user flow by browser personas, on one clock
with the k6 crowd for the rest of the population.

### Design, and why

- **Two layers.** Flows whose work happens on the device (receive and save a coupon, split, the
  NUT-18V payment, Cashlinks, checkout codes, cold boots) can only be measured in the real app, so
  they run in Playwright: one Chromium, one context per persona. Crowd load (acquire, poll, drain,
  atomic-send, receipt drains) is cheap per request and needs numbers, so it stays in k6.
- **Population.** Default 100 customers + 10 stalls. `BROWSER_CUSTOMERS=30` customers and all 10
  stalls are browser personas (40 contexts, `BROWSER_PERSONAS` caps it); the other 70 customers
  are the k6 crowd (`market-day.js` with `CUSTOMER_OFFSET`, so no identity is driven twice).
  The report header states the population and the split.
- **Stall slots.** Slot 0 = corda, slot 1 = bart, slots 2-9 = pool stalls. bart is the only stall
  with a published online shop, so the checkout-code journey runs against bart. `STALL_SLOTS=pool`
  makes every slot a pool stall (no real keys needed); `STALLS` / `CUSTOMERS` resize.
- **Real stalls' keys** are read at runtime from `MERCHANT_KEYS_FILE` (default
  `~/.jcode/scratch/merchant-keys.env`, `CORDA_NSEC=` / `BART_NSEC=` lines, mode 600). The file is
  parsed, not sourced; each key must decode to its expected pubkey prefix or the run aborts naming
  the variable, never the value. Keys live in memory only: never argv, the pool file, results or
  logs. No trace or screenshot is ever taken, so the backup-key import is not recorded.
- **Real stalls are treated gently.** Sales are 0.50 to 2.00. Their contexts block every kind-0,
  `d=imani:merchant` and `d=imani:terminals` publish (relay and gateway mirror): logging a stall
  into a fresh browser makes the app republish them, and the run must not change a real stall's
  profile, stall record or online_shop. Blocked attempts are listed in the report's notes.
- **Journeys** (seeded by `SEED`, weights in `real-day/schedule.mts`, think time 5-40 s): arrive
  (20% register as new, the rest import a backup key), buy (`/receive` + the stall's `/sell`), pay
  at a stall (`/redeem` -> the request string from the till -> `/scan` "Paste code" -> `/pay`;
  Paid on both sides), send (`/send?to=`, half of them bundles), send by link (`/send/link`, then
  another persona claims `/g#...`), use online (bart's `/online` code, then bart's Woo shop takes
  it in a real cart; with `E2E_SHOP_ADMIN_PASSWORD` the order is placed and set Processing, which
  is when the plugin redeems it), Cashlink (`/sell/cashback` then `/c/...`; `E2E_CAPTCHA_BYPASS`
  when the edge gate enforces), browse, card (`/buy/<stall>` through Stripe, **only** if
  `GET /api/v1/card-sales/ready/<stall>` says ready and only if Checkout is a `cs_test_` session,
  card 4242), leave and return (context closed, reopened from its storage: a cold boot).
- **Measured as the user sees it.** Every latency is from the user's action to the visible
  outcome: coupon in the wallet, Paid on both screens, the recipient's balance, link claimed.
- **Money conservation.** Every persona's balance is read off the screen before and after the day,
  stalls' as what they hold of their own coupons; the sum of changes must equal sales + Cashlinks
  - payments to the issuer (burnt) - checkout codes. A mismatch fails the run, naming personas.

### Limits

The per-address limits must be lifted for this IP (imani-deploy `scripts/loadtest-ratelimit.sh
off`). A probe at start checks; a full run stops if it sees 429s, a smoke run continues and reports
them apart. Three limits are NOT lifted (imani-deploy#405) and are paced by shared token buckets:
registration (gateway-core path limit 10/min, paced to 8/min), checkout codes
(`CHECKOUT_CODES_RL_PER_IP`, paced to 12 codes/min) and Cashlink claims (paced to 6/min). A 429 on
one of those is a **harness pacing failure**, counted apart from app failures. The report header
lists them.

### Output and gates

`loadtest/results/<date>-real-day-<size>.{json,md}`: per journey attempts, ok, fail, 429 (app),
429 (pacing), SKIPs with reasons, p50/p95/p99, failures with screen text and persona; the k6
crowd's metrics; a per-minute timeline; the money check. Exit non-zero on any of: a journey under
95% success, buy p95 >= 20 s, pay p95 >= 20 s, send p95 >= 30 s, an uncaught page error, a
settled-but-not-saved receive, a pacing 429, money not conserved, or a k6 threshold. Every string
written passes `real-day/redact.mts` (no nsec, no 64-hex, codes and tokens cut to 8 characters).

## Checkout codes

    node loadtest/signer.mjs &
    node loadtest/pool.mjs --size 20
    node loadtest/stalls.mjs --count 2 --verify
    npx vite-node loadtest/checkout-codes-make.mts -- --stalls 2 --codes 12      # GENERATION
    k6 run loadtest/checkout-codes.js                                            # VALIDATION + REDEMPTION
    npx vite-node loadtest/checkout-codes-make.mts -- --cleanup                  # afterwards

A checkout code (#402) is what a customer types at a stall's online shop: a
reference to coupon parts locked to the shop's key `S`, held by the code store
(imani-checkout-codes), which staging proxies same-origin at
`/v1/checkout-codes` on the wallet host. Two halves, because they are two
different kinds of work.

### Generation: `checkout-codes-make.mts`

Making a code is not one request. The wallet burns each coupon proof at the
mint, has the gateway sign its `S`-locked successor
(`/api/v1/wallet/vouchers/cashlink/lock`), then deposits the locked parts
(`POST /v1/checkout-codes`, NIP-98 by the customer). The lock step is cashu
blinding, which k6 cannot run, and reimplementing it would measure a path no
customer takes. So this is a Node driver around the wallet's own
`startCheckoutCode`, with the same ports e2e/checkout-codes-staging.e2e.mts uses.

Each code is a whole sale first: a stall (`stalls.mjs`) issues a coupon on its
NAP session, the mint backs it (polled as market-day.js polls), and a pool
customer makes a code from it for that stall's shop. By default the shop key is
a test key derived from the stall's private key, so the same stall always has
the same shop and the k6 half can sign as it.

With `--shops published`, the code is made for the shop the stall really
advertises: `online_shop.redeem_key` and `url` read from its own
`imani:merchant` record on the relay. That is how a real stall's online shop
gets codes it can redeem, for example a market day with a real stall in the
pool. The run never holds that shop's key, so `checkout-codes.js` refuses such
a file (it signs as the shop), and `--cleanup` only reads each code's public
balance. Redeem those codes at the shop itself.

| Flag | Default | Meaning |
|---|---|---|
| `--stalls` | 2 | stalls, the pool's first identities, as everywhere |
| `--stall-index` | none | comma-separated pool indices to use as the stalls instead, e.g. `1` for slot 1 |
| `--shops` | `derived` | `derived`: a test shop per stall. `published`: the stall's advertised online shop |
| `--codes` | 3 | codes to make |
| `--rate-start` / `--rate-end` | 1 / same | codes per minute, linear ramp between them |
| `--concurrency` | 4 | codes in flight at once |
| `--x` | `short` | `short`: the earliest `x` the gateway locks (now + 1h06m). Anything else: the latest |
| `--append` | off | add to the codes file rather than replace it |

It reports each stage separately (issue, mint wait, lock + deposit, the
deposit call alone) because the whole is dominated by the mint wait, and a
slow store would otherwise hide inside it. Output: `.loadtest-codes.json` (git
ignores it; it holds the shop keys) and
`results/checkout-codes-make-summary.json`. Exit 0 when the thresholds hold, 1
when crossed, 107 when setup fails.

**From one host, generation is bounded by issuance**, not the store: issuance
is rate limited per client IP (see the issuance ramp). A throttled code is
counted `rate limited`, never failed, so the run says how much less it applied
than it meant to.

### Validation and redemption: `checkout-codes.js`

The shop side, all NIP-98 signed by the shop key `S` through the sidecar. Four
k6 scenarios, so their numbers stay apart:

| Scenario | Executor | What it asserts |
|---|---|---|
| `validate` | `ramping-arrival-rate`, 5 to 25/min | real codes look up `reserved` with their amount and stall; unknown codes, typos (bad check symbol) and **another shop's** code all answer the same bytes as a code nobody made (R2) |
| `race` | one VU, `http.batch` | two orders hold one code at once: **exactly one** 200, the other `409 HELD`. Both redeem at once: exactly one 200 with parts. The winner asks again and gets the same body (R4). A third order is `409 REDEEMED` |
| `expired` | a few iterations | a code past its `x` looks up `expired` and a hold is `409 EXPIRED` |
| `check` | 4/min | the public balance check, `GET /v1/code-check/{code}`, no auth: `active`, and never parts or `S` |

The race is the reason the file exists. A store that lets two orders win one
code has handed the same customer money to two shops, so it is gated at
`rate==1.0` and cannot be tuned away. Each round **consumes** a code (it ends
redeemed), so the first `RACE_ROUNDS` (default 10) live codes go to the race
and the rest are looked up.

**Expired needs patience, not a clock.** The store expires a code when
`now >= x`, and the gateway will not lock an `x` sooner than an hour away. So
an expired case exists only when the codes file holds a code from a generation
run at least ~66 minutes old: the driver keeps the previous run's codes under
`previous` for exactly this. Until then the summary says `expired NOT
MEASURED`, rather than reporting zero failures of a check that never ran.

Knobs: `SMOKE=1`, `START_RATE`, `PEAK_RATE`, `MISS_SHARE` (0.3),
`RACE_ROUNDS`, `CHECK_RATE`, `MAX_VUS`, `RAMP_DURATION`, `PLATEAU_DURATION`,
`CODES_URL` (defaults to `GATEWAY_URL`; the shops' host
`codes.staging.398ja.xyz` serves the same routes, but codes and NIP-98 `u` tags
must agree on the origin).

### Choosing the thresholds

No baseline existed, so the latency marks come from what the **client** will
tolerate rather than from a guess about the server, and each was then checked
against one smoke run so none fails a healthy deployment by construction.

| Threshold | Value | Why |
|---|---|---|
| `race_one_winner`, `redeem_replays`, `misses_indistinguishable` | `rate==1.0` | correctness: one double win or one distinguishable miss is a defect, not noise |
| `unexpected_answer` | `rate<0.01` | the error rate. 404 and 409 are *correct* answers here, so `http_req_failed` (22% on a healthy run) cannot be the gate; an answer outside the set a request may get is |
| lookup | p95 < 500ms, p99 < 1500ms | it sits inside a shop's checkout page load; a plugin's whole store timeout is 10s (imani-coupon-core `CurlTransport`). Smoke: p95 370ms |
| hold, redeem | p95 < 1s, p99 < 2.5s | one transactional state change each, at order placement; twice the lookup's. Smoke: p95 452ms / 354ms |
| public check | p95 < 1s, p99 < 2.5s | reads the stall's profile from relays (cached 10 min). Smoke: p95 439ms |
| deposit (generation) | p95 < 3s, p99 < 5s | the wallet gives the store 15s (`STORE_TIMEOUT_MS`), and a deposit does a NUT-07 mint check. Smoke: p95 2.1s |
| whole code (generation) | p95 < 45s, p99 < 75s | the wallet waits up to 60s for the mint, so past ~75s the customer's screen has given up. Smoke: p95 38s, 21s of it the mint wait |

The first generation smoke used 2s / 30s and crossed both on a healthy run,
because the mint wait on staging was 13-21s, not the ~6s market-day measured on
2026-09-23. They were re-derived from the client budgets above rather than
loosened to whatever passed.

### Load on shared staging

Small by design, and bounded by the edge before it could be anything else:

- **The ramp:** lookups 5 to 25 a minute for ~5.5 minutes (~110 lookups),
  10 race rounds (~60 writes), ~20 public checks. Under the edge's per-address
  zones (30/min lookups, 60/min writes, 10/min public checks), so it does not
  lock the load generator's address out of anything a person on the same
  network is doing.
- **Generation:** each code is one real coupon issued (100 minor EUR by
  default), one mint backing, one lock per proof and one deposit. Twelve codes
  at 1 to 2 a minute is ~10 minutes of light issuance. This is the half that
  competes with other people's runs, through issuance's per-IP limit.
- **The ceiling from one host is the edge, not the store.** Raising
  `PEAK_RATE` past 30 only measures nginx's 429. Finding the store's own
  ceiling needs several addresses or a run from inside the deployment.

Tell whoever else uses staging before a generation run, as for any issuance.

### Cleaning up

    npx vite-node loadtest/checkout-codes-make.mts -- --cleanup

A maker **cannot cancel** a code (#472, `409 NOT_CANCELLABLE`): its value is
the holder's until `x`. So reserved codes are left to expire, which is why
generation uses the shortest `x` by default. At `x` the store sweeps them to
`expired` and the parts return to the maker through the refund key. Cleanup
releases any code an interrupted race left **held** (by its `held_by` order,
so it is not stuck for the 30-minute hold TTL), drops redeemed and expired
codes from the file, and keeps the rest. Codes the race redeemed are spent by
design: their parts went to the test shop's key, which nothing else holds.

The coupons a run issued belong to pool stalls and customers on a test
deployment, as every other scenario's do.

### Proven, and not

[`results/staging-2026-11-05-checkout-codes-smoke.md`](results/staging-2026-11-05-checkout-codes-smoke.md).
Against a stub store (`loadtest/stub/`, which keeps only the hold/redeem state
machine and the R2 bytes), the race was shown to **fail** when the store lets two
orders hold one code (`BROKEN=double`: exit 99, `race_one_winner` 0%), and setup to stop with
107 when the signer or the store is missing:

    STUB_CODES="$(node loadtest/stub/checkout-codes-fixture.mjs)" node loadtest/stub/checkout-codes-store.mjs &
    SMOKE=1 RACE_ROUNDS=2 CODES_URL=http://127.0.0.1:18087 k6 run loadtest/checkout-codes.js

The fixture overwrites `.loadtest-codes.json`, so move a real one aside first.
Against staging, one smoke pass of each half. **No ramp has been run against staging.**

## The bundle under relay failure (#552)

    node loadtest/signer.mjs &
    node loadtest/pool.mjs --size 60
    GATEWAY_URL=http://localhost:28081 PORTAL_URL=http://localhost:28084 RELAY_URL=ws://localhost:27778 \
      EDGE_SECRET=dev-edge-secret-local-only-32-plus-chars node loadtest/stalls.mjs --count 4
    docker run -d --name dm-fault-proxy --network imani-test_imani-internal -p 127.0.0.1:28099:8082 \
      -v "$PWD/loadtest/stub/dm-fault-proxy.mjs:/proxy.mjs:ro" -e FAIL_SHARE=0.3 node:22-alpine node /proxy.mjs
    # recreate gateway-core and account-app with
    #   GATEWAY_ATOMIC_SEND_DELIVERY_NIP17_CUSTOMER_WALLET_BASE_URL=http://dm-fault-proxy:8082
    GATEWAY_URL=http://localhost:5173 PORTAL_URL=http://localhost:28084 ACCOUNT_URL=http://localhost:28081 \
      EDGE_SECRET=dev-edge-secret-local-only-32-plus-chars FAULT_STATS_URL=http://localhost:28099/__fault/stats \
      VUS=20 DURATION=10m k6 run loadtest/bundle-retry.js

`GATEWAY_URL` is the **wallet origin** (`:5173`), not `:28082`. On the local stack gateway-customer
checks a NIP-98 `u` against the wallet origin. Signed for `:28082`, every coupon read answers
`401 URL mismatch`, no quote-backed coupon ever looks backed, and the run reports setup misses
instead of bundles. A first 20-VU run lost 138 of 165 iterations to this.

**Local stack only.** The proxy drops real deliveries on purpose. Point it at staging and it
breaks other people's payments.

On 2026-11-07 one part of a 10-part payment failed its relay publish once. The gateway delivered it
57 s later by its own retry, but the wallet had already called the part failed and stopped the
bundle, so the stall got €21 of €31. The other scenarios never saw this because no relay ever
failed under them. So this one **makes** it fail, at the boundary where it failed:

- `loadtest/stub/dm-fault-proxy.mjs` sits between gateway-core and customer-wallet.
- For `FAIL_SHARE` of atomic sends (chosen by hashing `send:<id>`, so the choice is stable per
  send), it answers the first `FAIL_ATTEMPTS` DM publishes with `502 RELAY_PUBLISH_FAILED`
  without forwarding them. This is what customer-wallet answers when no relay took the gift wrap.
- Self-DMs that return a reclaim are never failed.
- `GET /__fault/stats` reports how many faults were injected, so a run reports injected
  faults rather than assuming them.

### What an iteration is

1. A stall issues `PARTS` coupons.
2. A customer pays them back to that stall as one bundle, sending the bundle fields the wallet
   sends (`buildSendParams`), one part after another as `deliverCounted` does.
3. Each part is followed the way the **fixed** wallet follows it: a retry state (`DM_ERROR`,
   `DM_RETRY_PENDING`, `SPLIT_ERROR`) is not the end, and the run waits up to
   `PART_WAIT_SECONDS` (150 s, the wallet's `RETRY_WAIT_MS`).

On `RECLAIM_SHARE` of the parts seen in `DM_ERROR`, it also races a sender reclaim against the
gateway's retry. This is the race the gateway fix closes.

The probe is decided **once per part**, not on each status read. A first version rolled the dice on
every 2 s read, which turned a 25% share into nearly 100% over a two-minute retry. Every injected
fault (34 of 34) then ended `RECLAIMED` by the probe, and the gateway's own retry was never
observed, so the run measured the wrong thing.

### Gates

| Gate | Value | Why |
|---|---|---|
| `bundle_complete` | `rate>0.95` | Every part arrived: the thing #552 is about. Parts the probe reclaimed count as the customer's choice. |
| `part_recovered` | `rate>0.95` | Of the parts that went through a retry and were not reclaimed, the share that ended `COMPLETED`. |
| `reclaim_refused_while_retrying` | `rate==1.0` | A reclaim in `DM_ERROR` gets `409` (the retry won) or the token (the reclaim won). The pre-fix answer, `422`, fails this. |
| `no_double_handout` | `rate==1.0` | A part whose token went back to the sender never also ends `COMPLETED`. |

When the proxy injected nothing, the summary says `NO PART WENT THROUGH A RETRY` instead of
reporting a clean 100%. A rate with no samples prints `n/a (no samples)`, never 0%.

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
| `swap-race.js` | **yes** | a probe, not a ramp: does concurrent issuance still burn proofs? |
| `checkout-codes-make.mts` | **yes, at a low rate** | issues real coupons, so it shares issuance's per-IP limit |
| `checkout-codes.js` | **yes** | the store is proxied same-origin; the edge's 30/min lookup zone is the ceiling |

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
