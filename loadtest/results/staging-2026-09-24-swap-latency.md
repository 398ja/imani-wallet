# `/v1/swap` p95 1.70s: the mint is not slow, the gateway is racing

Investigated 2026-09-24 against staging, prompted by the P95 Latency by Endpoint
dashboard.

**The headline: `/v1/swap` latency is a symptom. The real finding is that
concurrent issuance makes the gateway swap the SAME backing proofs, and the mint
correctly refuses all but one as a double spend.** Throughput does not rise with
concurrency at all, and the refused attempts pay full swap latency before
failing, which is part of what the p95 is measuring.

## The mint is healthy

Every mint endpoint costs about **40ms of server-side work**. Measured from a
laptop over WAN, where the round trip itself is ~430ms:

| Call | Total | Implied server work |
|---|---|---|
| `GET /v1/info` | 437ms | ~10ms |
| `GET /v1/keys` | 435ms | ~5ms |
| `GET /v1/keysets` | 379ms | ~0ms |
| `POST /v1/mint/quote/bolt11` | 472ms | ~40ms |
| `POST /v1/swap` (empty body, 400) | 430ms | ~0ms |

A 1.70s swap is therefore **not the mint computing**. `cashu-mint/0.38.4`,
NUT-3/4/5/7/12 all enabled.

## What concurrency does

Issuance through `POST /api/v1/wallet/vouchers`, which swaps as part of backing
the new coupon. Three rounds at each concurrency, 3s apart, 1 sat each:

| Concurrency | Attempts | Succeeded | `Proof already used` | Success rate | Median latency |
|---|---|---|---|---|---|
| 1 | 3 | 3 | 0 | **100%** | 1241ms |
| 2 | 6 | 3 | 3 | **50%** | 1412ms |
| 3 | 9 | 3 | 6 | **33%** | 1892ms |

**Exactly three succeed every time.** One per batch, whatever the concurrency.
That is a fully serialised resource where the losers are destroyed rather than
queued, and it is the shape of a missing reservation, not of a slow service.

The refusal is explicit:

```
WALLET_002 Failed to issue voucher: Failed to swap tokens:
mintUrl=https://mint.staging.398ja.xyz
HTTP client error: 400 (mint_error_code=11001, reason=Proof already used)
```

`11001` is the mint refusing a double spend. **The mint is doing its job.** The
gateway selected the same backing proof for several concurrent issuances, swapped
it concurrently, and the mint burned it once.

### It is not per-issuer

Four concurrent issuances under **four different keys** still collided: one
succeeded, two failed `Proof already used`, one was rate-limited. So the backing
pool is shared across issuers, and two unrelated stalls selling at the same
moment can take each other's sale down.

### It is not proof-count scaling

Flat across face values, and if anything falling as the JVM warms:

| Face value | Latency |
|---|---|
| 1 sat | 1718ms |
| 2 sat | 1444ms |
| 8 sat | 1313ms |
| 64 sat | 1349ms |
| 1024 sat | 1096ms |

### The failures are in the p95

A refused swap costs as much as a successful one: the losers at concurrency 3
spent **~1.9s each** to achieve nothing. So the dashboard's 1.70s is measuring
real work *and* work that was thrown away, and the ratio worsens with load.

## Why this matters beyond a dashboard

- **Two customers buying at once is the normal case in a market.** At
  concurrency 2 the measured success rate is 50%.
- **The failure is user-visible and reads as a server fault.** The customer is
  standing at the stall and the sale fails with an internal error.
- It also caps the load suite: `loadtest/market-day.js` cannot model a realistic
  crowd against a deployment where concurrent sales destroy each other.

## What to look at

The gateway needs to **reserve or lock a backing proof before swapping it**, so
concurrent issuance selects different proofs, or serialises deliberately with
queueing rather than by losing. `docs/research/audit-double-spend-inflation-review.md`
does not cover this case; it is about the ledger, not about selection under
concurrency.

## A second, separate fault found on the way

**`gateway-portal` issuance is currently returning 500 for every request**, while
the wallet tier succeeds seconds apart with the same key:

| Tier | Result |
|---|---|
| `POST /api/v1/portal/vouchers` | **500** `Internal server error`, 3 of 3 |
| `POST /api/v1/wallet/vouchers` | **201**, 3 of 3 |

Every face value fails (1, 100, 500, 1000 minor EUR), so it is not amount
related. This is a **regression within the last hour**: the same call returned
201 earlier in the same session, during the market-day runs recorded in
`staging-2026-09-23-market-day.md`.

Each 500 carries an `error_id`, so the portal's logs will name the cause.
Unrelated to the swap race on the evidence available, and worth its own issue.

Note that the 500 is also indistinguishable from throttling to any caller, which
is issue #37: the portal flattens a 429 into a bare 500. That cost this
investigation several minutes of waiting out a rate-limit window that had already
cleared.
