# Staging after the payment-stack fixes, 2026-09-24

Six services deployed together, then the failures that motivated them re-measured
against the same experiments that found them.

- `cashu-mint/0.38.5`, `payment-adapter 0.16.3`, `gateway-portal 0.8.1`,
  `gateway-customer 0.14.1` (wallet-lib 0.3.6 via imani-bom 0.1.103)
- wallet migration **V7** and adapter migration **V12** applied on boot
- k6 v2.0.0, signer 247/s, run from a laptop over WAN

## TL;DR

Every failure that was measurable before the deploy is gone, and each was
re-measured rather than reasoned about.

| Finding | Before | After |
|---|---|---|
| Webhook refusals | 12,358 refused / 40 accepted, **0.323/s and climbing** | **frozen at 243**, 0/s |
| Concurrent issuance | 1 success per batch, whatever the concurrency | **0 burned proofs** at c=1,2,3,5 |
| Sub-10-sat voucher | fee 0, zero-amount invoice, quote stranded | **`face=2 computed=0 charged=1`** |
| Stranded payments | retried forever, invisible | **9 gave up**, gauge reads 9 |
| Market day | 0 coupons delivered | **3 minted, 3 delivered, 3 received** |

## The swap race is fixed

`loadtest/swap-race.js` replays the experiment from
`staging-2026-09-24-swap-latency.md`, which is why it now exists as a file
rather than as an ad-hoc command: a claim that a race is fixed is worth only as
much as the command that re-checks it.

| Concurrency | Before: succeeded | Rate | After: succeeded | Rate |
|---|---|---|---|---|
| 1 | 3/3 | 100% | 3/3 | 100% |
| 2 | 3/6 | 50% | 6/6 | **100%** |
| 3 | 3/9 | 33% | 5/6 | **83%** |
| 5 | not run (projected ~20%) | | 10/10 | **100%** |

**Zero `Proof already used` at every level.** Before, exactly three succeeded at
every concurrency: one per batch, the signature of a fully serialised resource
whose losers are destroyed rather than queued. The flat line is gone.

The one miss at c=3 was a rate limit, not a burned proof, and the probe counts
those separately for exactly this reason. Median issuance also halved, 1241ms to
~620ms, because the losers are no longer paying a full swap before being refused.

### A probe artifact worth recording

The first c=3 run reported **0%**, which would have read as the fix making
things worse. It was a lapsed session: every attempt after the first round
returned 401. The probe now re-logs-in once and counts `session_renewals`
separately, so an expired cookie can never again be mistaken for a lost race.
Worth stating because the wrong conclusion was one unexamined number away.

## The fee floor works, and the log proves it

    voucher_fee floored amount=2 percentage=10.0% computed=0 charged=1

`computed=0` is the old bug happening, and `charged=1` is it being stopped in
the same line. Every `face=2` voucher in this run settled; before the fix each
would have created a zero-amount invoice and stranded its quote.

`zero_fee_voucher_quotes: 0` across all new activity.

## The runaway retry is bounded

The nine quotes stranded by the fee bug were watched through the new cap, one
sweep per minute:

    attempts  3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10, then gave_up=9

Refusals then froze at 243 across three consecutive checks, and
`payment_adapter_forward_given_up` reads **9**. Before, the attempt count never
persisted on a throwing forward, so the cap was unreachable and the loop ran
forever.

243 is the bounded cost of draining a backlog that used to be infinite.

## The alert would fire, and would not false-page

All three new rules are loaded and `inactive`, which is correct now the failure
has stopped.

| | rate | vs floor |
|---|---|---|
| now | 0.0000/s | below 0.01/s, correctly silent |
| during the incident | 0.3230/s | **32x the floor**, fires |

The volume floor was added in review precisely so one malformed webhook on a
quiet deployment cannot page at critical. Both halves are now confirmed against
real numbers rather than only promtool.

## The market day

4 minutes, 4 customers, 2 stalls, matching the 2026-09-23 baseline.

    coupons minted    3
    coupons DELIVERED 3
    drains            73, 3 envelopes
    checks            236 passed, 0 failed

The baseline run drained **0 envelopes** however full the queue. This one
delivers three and the customers receive all three, so the sale completes
end to end.

Mint wait is ~7.5s avg (p95 9.2s), which is the seller's screen waiting and is
unchanged by this work. It remains the largest single cost in a sale and is the
obvious next thing to look at.

## Still open

- **The Purchase Issuer is still NOT MEASURED.** `PURCHASE_API_URL` is unset, so
  that behaviour has never run against staging. Unchanged by this deploy and
  still the largest gap in the mix.
- **The rate limiter is per client IP**, and one k6 process is one IP, so the
  whole crowd shares one budget. The day applies less issuance load than it
  intends. 1 request was limited here.
- **18 old PAID quotes at `amount=0`** remain undelivered from before the fix.
  They are now bounded rather than looping, but what a paid-unissued quote is
  owed is still an open decision.

---

# Addendum: the issuance quota is per-merchant, 2026-09-24

Deployed `cashu-mint 0.38.6` and `gateway-customer 0.14.2`, which rename the
identity header and make the mint's quota divide per stall instead of per
deployment.

## Why an addendum rather than a line in the table

The first verification proved the **mint** splits buckets, using curl with
hand-set headers. That says nothing about whether the **gateway** sends one, and
those are different claims: the second is the one the product depends on. The
issue was briefly reported as done on the strength of the first, which overstated
what had been measured.

## The test that actually discriminates

Exhaust one stall's per-minute burst, then immediately sell from another. A
shared bucket refuses the second stall; a per-merchant bucket does not.

| Step | Result |
|---|---|
| stall 0, 12 attempts | **10 issued, then 2 refused** (bucket spent) |
| stall 1, 4 attempts, seconds later | **4 issued, 0 refused** |

If the header never reached the mint both stalls would draw on one bucket and
stall 1 would have been refused 4 of 4. It was refused 0 of 4.

`STALL_OFFSET` was added to `swap-race.js` for this, because the probe always
started at pool index 0 and therefore could not ask the question at all. The
first attempt at this test silently re-ran stall 0 and would have been read as a
pass.

## Mint-side, for completeness

From a single address against the deployed mint:

```
no identity                            200 x10 then 429    address bucket
X-Mint-Issuer-Identity: stall-alpha    200 x10 then 429    own bucket
X-Mint-Issuer-Identity: stall-beta     200 x10 then 429    own bucket
X-Dalia-Identity: stall-gamma          429 x4              no alias
```

## Still true afterwards

15 issuances across 3 stalls in one minute: 15 of 15, zero burned proofs. The
swap-race result from the main report is unaffected.

## Open

- `@Async` work does not carry the thread-local and falls back to the shared
  address bucket. That is the previous behaviour, so nothing regresses, but async
  issuance gets no per-merchant benefit yet.
- **2000 per merchant is a different number from 2000 shared.** Worth lowering
  once real per-stall volume is known; both knobs are env-configurable.

---

# Addendum 2: the dashboards, and where the seller's 7.5s actually goes

Reviewed the Grafana dashboards for p95 bottlenecks after the deploy. The
headline finding corrects something the main report above says.

## The mint was never the bottleneck

The market-day run reported the seller waiting **7460ms avg, p95 9173ms** for
the mint, and the report above calls that "the seller's screen waiting" and the
obvious next thing to look at. That framing was wrong.

| | p95 |
|---|---|
| cashu-mint, all endpoints | **0.062s** |
| gateway-core `/profiles/{pubkey}/relays` | **2.13s** dashboard, **7.56s** measured |

The mint answers in 62ms. The 7.5s is a Nostr relay round trip taken because
the local nostrdb cache never answers a query.

`7460ms` and `7558ms` are the same number.

## What the cache is doing

```
nostrdb_cache_queries_total{source="local"}  = 0
nostrdb_cache_queries_total{source="hybrid"} = 150
```

Every query logs `local_query_failed` and falls through to the relay. The cache
is not empty: 361,629 events and 500MB on gateway-customer. The write path works
and the read path has never once succeeded.

One query decomposes as ~5.5s waiting for events/EOSE plus a hard 2s teardown,
returning `total=0`.

## A second, unrelated finding

`payment-receipts.q` redelivers 29 messages on an exact 30-second cycle, 580
consumptions per ten minutes, and the oldest was enqueued on **May 10** — about
390,000 deliveries for one message. Nothing reaches the DLQ, so the alert built
for it (`PaymentReceiptDlqGrowing`) has never fired: it counts DLQ arrivals, and
this loop has no exit.

## Filed

| Issue | |
|---|---|
| imani-gateway-core#88 | the nostrdb cache serves zero queries, 7.5s per lookup |
| imani-gateway-core#89 | payment-receipts.q redelivers forever, 137 days |
| imani-deploy#62 | no alert watches gateway request latency at all |

## What was ruled out

Checked and healthy, so none of these explain the latency: mint lock wait
(0.9ms), HikariCP acquire (max 4ms, zero pending), blocked threads (0 on
gateway-core), executor queues (empty), nostrdb query duration itself (2ms when
it runs).

---

# Addendum 3: correcting Addendum 2

Addendum 2 says the seller's 7.5s is the nostrdb cache failing on every query.
That is wrong, and the correction matters more than the original claim.

## What the deployed diagnostic printed

The cause had been swallowed as `e.getMessage()`, which for an
`EventStoreException` is the literal string "Failed to query events". Shipping
the logging change printed it in one deploy:

```
local_query_failed error=Failed to query events
  cause=java.lang.IllegalArgumentException: Invalid hex character at position 6
```

Position 6 is the `1` in `npub1...`. A bech32 npub reaching a hex-only query.

## I was generating the failure I was measuring

Every probe in Addendum 2 used an `npub1...` pubkey.

| input | result |
|---|---|
| `npub1...` (bech32) | `local_query_failed`, **7.5s** |
| valid 64-char hex | no failure, **2.06s** |

Real traffic produced **one** `local_query_failed` in 24 hours, and that one was
mine. The cache is not failing on 100% of queries.

`source="local"` being 0 is also deliberate rather than a bug: a cache-fresh
short-circuit was deliberately removed because it served stale reads. The code
says "the relay is the authority. Always consult it."

## The real bottleneck

With valid input the endpoint is still a flat 2.06s +/- 0.002, which is exactly
the 2.1s p95 the dashboard showed:

```
13:02:37.358  relay query_completed    <- the relay has answered
13:02:37.359  CLOSE sent               <- +1ms
13:02:39.359  query_complete           <- +2000ms EXACTLY
```

Two seconds of waiting after the data is in hand, from a CLOSE handshake whose
own comment says "CLOSE messages don't get responses per the Nostr protocol"
and which then joins for 2000ms waiting for one. Filed as
imani-gateway-core#90.

## What survives from Addendum 2

- The endpoints really are ~2.1s p95 while the mint answers in 62ms.
- The market-day run really did blame the mint for a 7460ms wait it did not
  cause.
- The logging and metric changes earn their place: the cause was unreadable
  until they shipped, and readable one deploy later.

## The lesson worth keeping

A measurement taken with a malformed input measured the malformed input. The
7.5s was real, reproducible and consistent to within 20ms, and still meant
something other than what it looked like. Contrast against a known-good input
is what separated them, and it was one command.
