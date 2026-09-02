# Wallet performance testing

Two suites measure this wallet, and they are automated to different degrees
because they can honestly support different degrees.

The **browser suite** (`perf/`) measures what happens on the customer's device.
It is reproducible on a laptop, needs no backend, and runs on every commit.

The **gateway suite** (`loadtest/`) measures the service under load. It needs a
real deployment, that deployment is shared, and so it cannot gate anything. An
operator runs it deliberately.

Spec: [#15](https://github.com/398ja/imani-wallet/issues/15).

## Why two suites

The wallet holds coupons on the customer's own device, so the work that decides
whether the app feels fast happens in the browser: opening the app, writing
coupons to storage, totalling a balance, draining arrivals. That cost is
measurable on a laptop with nothing else running.

Gateway capacity is a different question with a different shape. It needs a
deployment that resembles production, and staging is single-host and shared, so
two runs collide and neither is reproducible.

Treating these as one problem produces a suite that is either too slow to run
often or too weak to mean anything.

## Settled decisions

Each of these was decided against a real alternative. The reason is recorded so
a later reader can tell a deliberate constraint from an accident.

### Both suites

**Runs are named by date and subject.** `2026-09-01-cold-boot`, never `run-007`.
The retired `imani-apps` project used a global sequence, which fractured into
`007b`, `009c`, `010b` as variants multiplied, because a shared sequence implies
runs are comparable when they are not. A date says when and a subject says what,
and neither claims more.

**Every run emits two artifacts**: a machine summary (JSON) and a generated
report (Markdown). The report is **delta-shaped**: a run that changes nothing is
a few lines, a run that regresses is a full account of what moved. Length
carries the signal, so a regression is visibly larger in the diff.

**Generated reports are appendable.** The most valuable artifact the retired
project produced was a human-written report identifying a defect that the
numbers alone did not name. Prose appended below the generated section survives
regeneration.

**Measurements observe only what a customer or a caller could observe.** Time to
a usable app, time for a balance to appear, gateway latency and success rate. A
measurement that reaches into a module to time an internal function is measuring
an implementation detail, and it will fail the day that detail is refactored
while the customer's experience is unchanged.

**No production module gains a hook, export or flag for the benefit of a
measurement.** Both suites enter at boundaries that already exist: the gateway's
HTTP surface, and the built bundle in a real browser.

**A flow asserts it actually succeeded before its duration is recorded.** A fast
failure otherwise reads as excellent performance. The retired project's early
runs proved a load script can be confidently wrong: it mistook a terminal state
for an intermediate one and reported failures that were its own fault.

### Browser suite

**It drives a real browser.** Three of the four subsystems being measured are
invisible from Node: only a browser has the storage engine, the render pipeline
and the contended event loop. The retired project attempted this once and its
`bench-wallet-sync.mjs` explicitly did *not* drive a browser, importing modules
into Node with a shim instead. That script cannot observe storage contention or
render cost at all: a module benchmark wearing a browser benchmark's name.
Repeating it would produce a suite that reports green while blind to what it
claims to measure.

**Scenarios are isolated, not a journey.** A combined journey yields one number
that can move for four reasons, which cannot direct anyone to a cause.

**Fixtures are recorded from the real issuing flow, never synthesised.** Coupons
are client-held by design, so the only honest path into stored state is a browser
performing a real issue and receive. That is slow, so it is recorded once and the
recording is restored per commit. Invented state can reach any size but drifts
from what the flow actually writes, and then the suite measures a shape
production never produces.

**Snapshots are invalidated by a source hash, not a schema version.** A version
bump only catches a change in the *shape* of the store. A change to *what gets
written* into an unchanged schema is exactly the drift that makes a measurement
lie, and a version check sails straight past it.

**Measurements are taken on a ladder, and the assertion is on shape.** A lone
measurement reports a value that hardware noise moves, and hides quadratic
behaviour behind a fast machine. Cost per coupon that is flat passes; cost per
coupon that climbs fails, even when the absolute numbers look comfortable.

**Thresholds are baseline-relative, with one absolute ceiling on cold boot.**
Purely relative bands ratchet: a few percent per commit never trips a band, and a
year later the wallet takes seconds to open with every run green. Cold boot is
the number a customer directly experiences, so it also gets a fixed limit.

**Baselines are committed to the repository.** Accepting a slowdown means editing
a tracked file, which surfaces in review. An external time-series store puts the
number where no reviewer will see it.

### Gateway suite

**Signing happens in a sidecar process, not in the load generator's JavaScript
engine.** This is settled, not to be re-evaluated. The retired project spent an
entire spike step on it: in-engine signing came out roughly 67× over budget at
p99 (676ms), while a sidecar in cluster mode sustained 2400 req/s at 61ms p99.
Both results are recorded in that project's `loadtest/spike-0/` and
`spike-0b/`. Re-running the failed experiment to rediscover the same answer is
the most predictable waste available here.

**Signing cost is reported as a share of each iteration.** The sidecar is fast
enough but not free. When its share grows large, the run is measuring the load
generator rather than the gateway, and that should be visible rather than
inferred.

**The target deployment is chosen at run time**, read from the environment and
defaulting to staging.

**Abort signals come from what real runs observed, not what a plan predicted.**
This distinction is load-bearing. The retired project's plan predicted a
connection pool would fail with `Connection is not available`; under load it
actually failed with `HikariDataSource has been closed`, so the predicted signal
never fired while the run produced hours of worthless data. Ported signals are
marked as observed or unproven.

**The load generator's own saturation invalidates a run**, so a laptop's limit is
never mistaken for the gateway's.

**Issuance is implemented first.** It produces the coupons that sending,
splitting and draining all consume, so it is both the first measurement and the
tool that fills the pool for everything after it.

**Manual until proven, then scheduled.** The retired project's first two real
runs both surfaced defects in the *scripts* before revealing anything about the
system. A schedule firing into unproven scripts generates noise that trains
people to ignore it.

## What is deliberately not measured

**Redemption has no gateway scenario**, by
[ADR 0003](../docs/adr/0003-redemption-is-not-load-tested.md). There is no
gateway path to measure, and building one in order to measure it would install
the very dependency the design exists without. Its device-side cost is measured
in the browser suite instead, so the exclusion does not leave it unmeasured.

Also out of scope, with reasons in the spec: committed objectives (no baselines
exist yet to derive them from), soak runs, mixed workloads, native Android
performance, third-party upload throughput, registration throughput, and
optimising anything this suite happens to find.

## A local run is not a capacity number

A run against a shared single-host deployment measures **that host**, not the
system in the abstract. A run on a laptop measures that laptop. Numbers from
either inform planning; neither is production capacity, and quoting them as such
is a misuse this document can warn against but not prevent.

## Layout

```
perf/                      browser suite
├── baselines/             committed reference numbers
├── results/               run artifacts, date-plus-subject
└── snapshots/             recorded wallet state (not committed)

loadtest/                  gateway suite
├── lib/                   ported helpers, renamed to this glossary
└── results/               run artifacts, date-plus-subject
```

Vocabulary follows [`CONTEXT.md`](../CONTEXT.md): coupon, stall, customer,
redemption, scenario, run, baseline, scaling ladder, fixture snapshot. The
retired project's words (voucher, merchant, user) are renamed on the way in;
since that project is retired and nothing will be merged back, preserving a
comparable diff has no value, and a port is the one moment renaming is free.

## Measuring a populated wallet

    npm run perf

Measures cold boot three ways: empty, then once per recorded fixture, as
`cold-boot`, `cold-boot-5`, `cold-boot-20`. Takes about ten seconds.

**No backend is needed**, and that is checked rather than assumed: the numbers
above were measured with `gateway-customer` and `imani-mint-rest` stopped. What
the run does need is the proxy TABLE from `vite.config.ts`, because the wallet's
unlock posts to `/api/v1/auth/*` and the SPA fallback would otherwise answer
with `index.html`. The wallet then stays locked and the run measures the lock
screen instead of a customer's wallet — `measureColdBoot` refuses to report
that, which is how the gap was found.

The rungs matter as a **pair**. An empty wallet boots fast no matter how badly
storage scales, so the empty number alone cannot see the cost that matters. And
a single populated number cannot either: what says storage is scaling is
`cold-boot-20` staying level with `cold-boot-5`. Today they are within noise of
each other. A rung climbing away from its neighbour is the signal.

A restored wallet always boots **locked**, and the measurement includes typing
the passphrase. That is not a limitation of the snapshot: the wrapping key is
generated non-extractable and cannot be serialised at all, so this is exactly
the boot a returning customer experiences. The populated ceilings are 1500ms
rather than 1000ms for that reason.

Recording is the slow half and is not part of this loop — see below.

## The cost shape

The ladder is the assertion that matters most, and the only one that survives
moving to different hardware.

A single measurement tells you a value. Hardware noise moves it, and it hides
accidental quadratic behaviour behind a fast machine: 500 coupons opening in
half a second looks perfectly healthy right up until 5000 coupons take a
minute. Measured at several counts, the same scenario answers a better
question — does each coupon cost the same when there are more of them?

    cold-boot cost shape: flat: cost per coupon is not measurable above noise
    (early 0.000ms, late -0.267ms per coupon).

    | coupons | ms | ms per coupon | marginal ms per coupon |
    | --- | --- | --- | --- |
    | 5 | 305 | 61.000 | — |
    | 20 | 305 | 15.250 | 0.000 |
    | 50 | 297 | 5.940 | -0.267 |

That is a real run, and it is the healthiest result available: opening a wallet
holding 50 coupons costs no more than one holding 5, so the per-coupon cost is
lost in the noise of the fixed cost. A negative marginal figure means the larger
rung measured slightly *faster*, which is noise, not an improvement.

**Read the last column, not the third.** `ms per coupon` falls from 61 to 6
here, and that fall is meaningless: it is the fixed cost of opening the wallet
being spread thinner. Marginal cost — the difference between two rungs over the
difference in their counts — cancels that fixed term instead of estimating it,
which is why the check compares two differences rather than two averages. A
quadratic hides completely in the third column and is obvious in the fourth.

The threshold is **2.5x** growth in marginal cost across the ladder. Generous
on purpose: the ratio divides two differences, so it amplifies noise from four
wall-clock numbers rather than two. What it exists to catch does not arrive as
a 3x drift — quadratic growth over two orders of magnitude arrives as tens or
hundreds.

**Three rungs is the minimum, and fewer is refused rather than passed.** Two
points define a line and can only ever look flat, so a two-rung ladder would
report success without having checked anything.

The ladder prints on **every** run, unlike the rest of the report, which is
delta-shaped. A shape that only appears once it has already failed cannot be
watched.

### `--require-fixtures`

    npm run perf -- --require-fixtures

Fails when there are no fixtures, or too few to form a ladder, instead of
measuring less and reporting green.

Snapshots are gitignored, so a laptop may legitimately have none, and degrading
to the empty wallet while saying so is right there. In CI it is wrong: an empty
wallet boots fast however badly storage scales, so a runner without fixtures
measures the one case that cannot fail while the populated rungs and the shape
assertion silently stop running. That is this suite's own failure mode wearing
its clothes, and it is what the flag exists to make loud.

## Recording a fixture

Requires the local stack, and the **matched image set** — the published gateway,
mint and vault images do not work together (see `deploy/compose.override.yml`,
and #36 for how each mismatch presents).

    ./deploy/migrate-keys-to-hashi.sh        # once, before the new vault starts
    VAULT_HASHI_ENABLED=true \
      VAULT_JPA_IMAGE=imani-vault-jpa:libfix \
      MINT_REST_IMAGE=imani-mint-rest:libfix \
      GATEWAY_CUSTOMER_IMAGE=imani-gateway-customer:frameseq ./deploy/up.sh
    ./deploy/check.sh
    npm run build                            # the recorder measures dist/
    npm run perf:record -- --coupons 5

Writes `perf/snapshots/coupons-5.json`. Any count works; `--coupons 20` gives
the next rung. Recording is per-coupon work against the mint, roughly 12s each,
so 20 coupons take about five minutes.

`DEBUG_RECORD=1` traces the browser console, failed requests and every gift-wrap
query with its response. That tracing is what found all five faults above.

**Record one wallet at a time.** Issuance goes through the gateway's single
cashu wallet, and concurrent swaps make the mint reject proofs it has already
spent (`mint_error_code=11001`). The run fails as `never produced a token`,
naming neither the contention nor the wallet, and the gateway stays broken for
every later run until its H2 file is cleared — so one careless parallel run
costs the next few as well. `check.sh` detects that state and prints the two
commands that fix it.

Two parallel runs sometimes both succeed, which is worse than if they always
failed: it makes concurrency look supported until a longer run collides.

Every fourth coupon is issued in **USD**, so a recorded wallet holds more than
one currency — adding EUR to USD would be a confident lie, so the wallet keeps
one figure per currency and aggregation has to walk them separately. A
single-currency fixture would measure the easy path. `--currencies EUR` records
in one currency.

Two things the recorder will not do:

- **Write a partial snapshot.** Fewer coupons stored than issued and it refuses,
  naming both numbers. A plausible-looking fixture is the dangerous failure: the
  ladder would measure 1 coupon while claiming 1000.
- **Invent state.** `--customer <name>` records from a wallet the seeder already
  filled, which is useful when issuance is broken, but the coupons are still
  real ones from the real flow. Bearer tokens are spent once, so a customer
  already recorded from will not yield its coupons twice.

## Verifying the recorder

    ./deploy/up.sh && ./deploy/check.sh
    npm run build
    npm run perf:verify-recorder

Checks each of the recorder's acceptance criteria against the running stack and
says which hold. Every check observes the real thing: the real seeder, the real
onboarding form, real browser storage. No stubs, no fixtures.

Current result:

    PASS  the real issuing flow runs end to end
    PASS  login goes through the real onboarding form
    PASS  capture reads IndexedDB and localStorage
    PASS  the snapshot is stamped with a source hash
    PASS  the wallet holds the coupons that were issued

    5/5 criteria verified against the running stack

The last one failed at `0/3 stored` for as long as #36 was open. While it did,
this file recorded the failure with the blocker named, which is more useful
than "the recorder is blocked" — it says exactly how much of the recorder
worked.

### Why there was no way around #36

Every route into a populated wallet goes through gift-wrapped delivery.
`issueAndDeliver` always ends in `deliver()`, the scan screen only routes codes
rather than ingesting tokens, and coupons are client-held so the backend has no
store to read from. Checked before concluding it, rather than assumed. So the
only way forward was to fix the delivery bug itself.

### Two mistakes this check caught in itself

It first reported login as failing. The wallet renders `Unlocking…` **in place
of** `Add key and unlock`, so waiting for that button text to disappear returns
while login is still running. Same class of error as the 31ms cold boot: it
waited for the wrong signal.

The recorder's own wait was worse. `page.waitForFunction` with an **async**
predicate resolves on the returned Promise, which is always truthy, so it
returned instantly without polling. Counting IndexedDB records needs `await`,
so the helper cannot be used at all; it is now an explicit loop.

The recorder also now refuses to write a **partial** snapshot, not just an
empty one. A partial snapshot is the more dangerous case: it looks plausible,
every later scenario trusts it, and the ladder would measure one coupon while
claiming a thousand.

## Verifying the snapshot round trip

    npm run perf:verify-snapshot

Capture and hashing are checked elsewhere. This checks the boundary nothing
else touched: whether state written back into a **fresh browser context**
actually reconstitutes the wallet. That is where a snapshot stops being a file
and starts being a measurement.

    7/7 checks passed

| Check | Why it exists |
|---|---|
| there is real state to round trip | Six of seven checks passed vacuously on the first run, comparing an empty wallet to an empty wallet |
| every database and store comes back | A silently dropped store measures a wallet that never existed |
| every localStorage key comes back | Wallet state is not only IndexedDB |
| record counts match exactly | |
| record **contents** survive | Restoring the right number of empty objects would pass every check above |
| database versions survive | A store restored without its schema reads back identically and then behaves differently |
| restore **replaces** rather than merges | Otherwise a 100-coupon run after a 1000-coupon one silently measures 1100 |

### The bug this found

`restore()` had never been executed. Its first contact with real data threw:

    DataError: the object store uses out-of-line keys and has no key
    generator and the key parameter was not provided

`src/lib/resume.ts` creates its `wrap` store with **no keyPath and no
generator**, so its keys live outside the records. `capture()` recorded only
the values, so the keys were lost and restore could not put them back.

Fixed by capturing `getAllKeys()` for out-of-line stores and passing the key
alongside the value on the way back in. Unconditionally passing a key is not an
option: an in-line store rejects it.

This would have broken every fixture, and no unit test would have caught it,
because the failure needs a real IndexedDB with a real out-of-line store.

## Verifying that a fixture drives a measurement

    npm run perf:verify-fixture-boot

The other checks prove the parts. This proves they compose, along the path a
scenario actually takes: **record, load, restore, boot, unlock, measure**.

    10/10 checks passed

Until this ran, the fixture machinery was a well-tested set of pieces with no
evidence they worked together. A snapshot that restored perfectly into storage
the app then ignored would have passed every other check in this suite while
measuring an empty wallet.

### The check that measured nothing

Its own "a measurement runs against the fixture path" check called
`measureColdBoot` **with no fixture at all**. The scenario had no way to accept
one: it opened a fresh context and measured an empty wallet, then reported
success under a label claiming otherwise.

`measureColdBoot` now takes a `fixture`, restores it before the measured
navigation, unlocks it, and reports `couponsHeld` so a result cannot overstate
what it measured. Two checks now hold it honest:

| | empty | restored |
|---|---|---|
| records held | 0 | 1 |
| cold boot | ~106ms | ~258ms |

An empty wallet boots fast however badly storage scales, so a fixture that
measured the same as no fixture would not be measuring the wallet.

One assertion had to be relaxed, and the reason matters: a restored wallet goes
**straight to its lock screen** without passing through `Restoring your
session…`, so `observedStarting` is legitimately false there. What proves that
measurement is real instead is that the wallet held the fixture's records and
settled on the customer's own wallet.

### A restored wallet boots locked, and that is the design

The first run failed on exactly that: the wallet booted to *"Welcome back /
Unlock"*, and a scenario would have measured the unlock screen.

Chasing it found two real gaps and one hard boundary.

**sessionStorage was not captured.** The wallet's session lives in
`imani-wallet:resume:v1`, not localStorage. Now captured and restored.

**httpOnly cookies were not captured.** `merchant_session` is httpOnly by
design, so no page script can read or write it. It travels through the browser
context instead, which is why `capture` and `restore` each take an optional
one.

**The session itself cannot be carried, ever.** The resume record is encrypted
under a wrapping key that `src/lib/resume.ts` generates **non-extractable**:

    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

`getAll()` cannot serialise a non-extractable `CryptoKey`, so a snapshot
carries the ciphertext without the key, and the wallet correctly discards a
record it cannot decrypt:

    [resume] discarding an unusable resume record: no wrapping key

That is the design working, and its comment says so: *"there is no code path —
ours or an attacker's — that turns this back into bytes."* A fixture that could
restore an unlocked session would be a hole in that.

So the fixture carries the customer's **encrypted** key, exactly what a
returning customer's browser holds, and the scenario types the passphrase
exactly as a returning customer does. That is the more faithful measurement
anyway: it is the boot a customer really experiences on their second visit.

## What the recorder learned about delivery

Recording a fixture needs the wallet to actually receive what was issued, and
that exposed how the wallet takes delivery.

**The wallet fetches its DMs once at startup**, then relies on a live
subscription. If that single fetch draws a losing answer from the gateway, the
wallet shows nothing and never asks again. Waiting longer changes nothing,
because nothing is going to ask a second time.

So the recorder **waits for the gateway to serve the gift wraps before opening
the wallet**, removing the ingestion race rather than hoping to outlast it.

It counts **coupons**, not records: counting every store meant the resume
wrapper written at login satisfied the wait, so the loop reported `stored 1`
while the wallet held no coupons and the guard then refused. Two numbers
disagreeing, from one question asked two different ways.

It also used to **reopen the wallet** when coupons had not arrived, the only
retry a customer has. That was recovery for #36, and once #36 was fixed the
reload became the bug. `DmPollService` redeems its gift wraps in one sequential
loop, so a reload part-way through kills the loop where it stands, and it lands
on `/login` because the resume key is scoped to the tab. The wallet recorded 1
of 5, then 5 of 20 — each time looking like a delivery fault rather than an
interrupted loop. The recorder now waits, prints the count as it climbs, and
reports a genuine stall instead of reacting to one.

### Five faults that all looked like a delivery bug

Between them these stored exactly one coupon out of five, and every one of them
presented as the gateway losing coupons:

- The recorder's static server fell back to `index.html` for a **missing build
  asset**, handing the browser HTML where it asked for a JavaScript module.
- `shared/api.js` reaches `shared/profileService.js` by **dynamic import**, a
  literal path Vite never sees, because `legacyBridge` loads the bridge with
  `?url` and nothing follows what those files import at runtime.
- `profileService.js` injects `/lib/profile-service.min.js`, which exists in
  **no build of this repo**.
- `getProfile()` could **hang forever** inside the sequential redemption loop,
  stalling every coupon behind it.
- The reload described above.

The lesson is in the shape of the symptom: a count that is short by four is not
evidence about where the coupons went. Each of these was found by tracing the
loop itself rather than reasoning about the count.

## On the tolerance band

The band is 35%, not the 25% it started at. At 25% a run reported cold boot
regressing to 138ms purely because a browser verification was running on the
same laptop, and it measured 108ms again when idle.

A band that cries wolf on a busy machine is one people learn to ignore, and the
**absolute ceiling** is what actually guards the number a customer experiences.
The band catches shape; the ceiling catches truth.
