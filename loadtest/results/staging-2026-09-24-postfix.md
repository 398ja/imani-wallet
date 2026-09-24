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
