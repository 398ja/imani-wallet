# Staging market-day run, 2026-09-23

First run of the **mix** (`loadtest/market-day.js`, ADR 0013) against staging
(`wallet.staging.398ja.xyz`), from a laptop over WAN.

- k6 v2.0.0, signer sidecar 12 workers
- signer verified first: 5507 signatures, **0 invalid**, 274/s, p99 273ms
  (checker-bound, see `README.md`)
- runs at 4 customers and 2 stalls, deliberately small: staging limits a caller
  address to **100 requests/minute**, and 6 pollers on a 10s period is ~36/min

## TL;DR

The mix runs against staging and its numbers are honest, but **two of three
behaviours were absent or partial**, and that is the finding rather than a
harness fault.

| Behaviour | Result | Why |
|---|---|---|
| Customer, polling | **RAN**, 71 drains over 4m, 0 envelopes | healthy |
| Customer, acquiring | **BLOCKED at first, then RAN** | see the correction below |
| Stall | **RAN**, 49 drains over 4m, 0 envelopes | healthy |
| Purchase Issuer | **NOT MEASURED** | `PURCHASE_API_URL` unset, unreachable from here |

Every check passed and **none failed**, across four runs. Nothing here suggests
the service is wrong, though one latency finding below is unexplained.

## What the run found

### Drain latency is two populations, not a tail

The headline p95 of ~2.5s is misleading if read as a distribution. Across a
four-minute run, an authenticated drain is either **fast or fixed-slow**, with
almost nothing between:

| Population | Share | Latency |
|---|---|---|
| Fast | ~83% | median **~140ms** |
| Slow | ~17% | **2181-2354ms** |

Ten samples landing within 172ms of each other at ~2.2s, against a 140ms
median, is a **fixed cost** rather than congestion: queueing produces a smooth
tail, and this is a step.

It is not the network and not the client:

| Component | Measured |
|---|---|
| `http_req_connecting` | avg 1ms, max 26ms |
| `http_req_tls_handshaking` | avg 13ms, max 252ms |
| `signing_ms` | avg 6ms, p95 8ms |
| `http_req_waiting` | avg 260ms, **p95 2202ms** |

#### What was ruled out

Each of these was tested rather than argued about, and the first two were
**hypotheses this run disproved**:

| Hypothesis | Test | Result |
|---|---|---|
| Warm-up | 4-minute run, bucketed by elapsed time | **No.** 4/13, 5/29, 5/36, 6/42 slow per bucket: a steady ~15%, not a decaying one |
| Contention between behaviours | slow share per behaviour | **No.** customers 17% (12/71), stalls 16% (8/49), indistinguishable |
| An error path | status of slow responses | **No.** all 20 slow drains are `200`, as are all 100 fast ones |
| The network | `http_req_connecting`, TLS timings | **No.** connect 1ms avg, TLS 13ms avg |
| The signer | `signing_ms` | **No.** 6ms avg, 0.9% of an iteration |
| Pacing alone | 12 unauthenticated drains, 10s apart, by curl | **No.** 0.43-0.54s every time, no step |

#### What it is not explained by, and what to try next

The isolated scenario **does not show it at all**. `drain.js` against the same
deployment in the same session: **958 drains, p95 261ms**, no step.

So the difference is not volume, since `drain.js` pushes far harder. The
remaining differences between the two are that the mix **paces** its polls 10s
apart and spreads them across **many identities**, while `drain.js` polls
continuously. Paced *unauthenticated* requests do not reproduce it, which
leaves the authenticated, per-identity path as the place to look.

**Deliberately not guessed at beyond this.** The honest statement is that ~17%
of authenticated drains cost 2.2s under the mix's access pattern and none do
under the drain ramp's, and that the cause is not yet known. The mix now warns
about the shape in its own summary, naming it a step rather than a tail, so
nobody reads the p95 as load.

### Contention was not observable at this size

Both behaviours show the same fast median and the same fixed-slow share (17% and
16%), which is the signature of a shared cause rather than one behaviour
starving the other. At 4 customers and 2 stalls that is unsurprising: the run is two orders
of magnitude below the intended day, because the per-address limit makes a
realistic crowd unreachable from one host.

**So this run does not answer the contention question.** It answers "does the
mix run, and are its numbers trustworthy", which was the point of a first run.

### Acquiring was not blocked, and the first explanation was wrong

The first runs reported **0 coupons acquired** and blamed the session cookie,
repeating this repository's own README: that staging demands a cookie a NIP-98
client cannot obtain. That was **wrong**, and worth recording because it stood
unchallenged through two earlier run reports.

A script **can** log in. Verified against staging:

| Step | Result |
|---|---|
| `POST /auth/init {npub}` | **200**, returns a challenge |
| Sign kind-27235, `POST /auth/complete` | **200**, sets `merchant_session` |
| `GET /auth/validate` | **200**, `coupon:pay,coupon:receive` |

So authentication was never the problem. **Authorisation** was, one layer in: a
pool identity is a *customer*, and the portal answers `403 Insufficient
permissions` because `coupon:issue` belongs to a stall.

#### What makes a key a stall

Publishing a **stall record**: a kind-30078 event tagged `d=imani:merchant`, the
same one an owner's phone writes when setting up a business. Measured end to
end on staging:

| Moment | Permissions | Issue |
|---|---|---|
| Before publishing | `coupon:pay,coupon:receive` | **403** |
| ~5s after publishing | `coupon:pay,coupon:receive` | **403** |
| ~90s after publishing | `coupon:issue,coupon:pay,coupon:redeem,coupon:receive` | **201** |

The record was on the relay within seconds and readable through the gateway's
own `/api/v1/nostr/query`, so the delay is the ACL resolving it rather than
propagation. `loadtest/stalls.mjs` therefore polls instead of sleeping.

#### The detour worth not repeating

A **terminal credential** (ADR 0005) was tried first, because that ADR describes
the gateway resolving permissions from a voucher. It was the wrong tool: a
terminal is how a *second device* gains authority for a stall that already
exists. It also cannot work on staging today, since the gateway's mint quote
answers `500 mint_error_code=90008` while the mint itself is healthy and issued
a bolt11 quote directly when asked.

The question that ended the detour was a good one: *the merchant sells from
their phone, that works today, why introduce a terminal?* The answer was that
there was no reason to.

#### A domain error it exposed

The mix had **customers issuing to themselves**. A customer acquires a coupon
because a stall issued one, and only a stall can. Stalls now issue, spread
across the pool's stalls by VU so the crowd does not queue behind one.

With stalls enrolled, a 90s run at 4 customers and 2 stalls acquired **4
coupons**, 92 checks, 0 failed.

## A bug this run found

The stalls' poll rate was computed as
`Math.max(1, Math.round(STALL_COUNT / STALL_POLL_SECONDS))` polls per second.
For 2 stalls on a 10s period that is `max(1, round(0.2))` = **1 per second, five
times the intended load**. The first staging run recorded **120 stall drains in
two minutes where 24 were intended**.

It was correct at the default of 10 stalls, `round(10/10) = 1/s`, so it would
have survived every run that did not vary the count.

Fixed by stating the rate over the poll period (`STALL_COUNT` per
`STALL_POLL_SECONDS`), which needs no division and has nothing to round.
Verified at 2, 5 and 10 stalls, and the re-run produced exactly **24**.

## What still cannot be measured here

| Thing | Why |
|---|---|
| Acquiring coupons | portal session cookie, as above |
| Sending, redemption, splitting | no gateway path at all (ADR 0003, 0004) |
| Purchase Issuer | `/api/v1/purchases/owed` is not exposed to a laptop |
| A realistic crowd | 100 requests/minute per caller address |
| Draining anything | zero envelopes: nothing populated the queues |

That last one matters for reading the drain numbers. Every drain in this run
came back **empty**, so this measures the cost of answering "nothing waiting",
exactly as `drain.js` does and for the same reason. The mix's own summary warns
that its drain numbers are not comparable with `drain.js`, and on **this** run
that warning does not apply, because neither had anything to return. It will
apply the moment a run populates the queues.
