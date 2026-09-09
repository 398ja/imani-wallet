# 07: Reads and reports

**What to build:** `/v1/reports/records` (transactions and coupons),
`/v1/reports/dashboard` (totals), and `/v1/stalls/{nip05}` (resolve a stall).

Computed over rows the caller supplies, exactly as `/v1/holding/value` already
is. Cheap, no new custody question, and probably the first thing a bookkeeping
integration asks for — which is why it is worth shipping early even though it is
the least interesting ticket here.

POST rather than GET for anything carrying coupons. The holding IS the request,
and coupons in a URL land in access logs and proxy caches; a logged bearer coupon
is a spendable one. `/v1/holding/value` already made this trade and the reason
is written down there.

There is no total across stalls, for the same reason that endpoint has none: a
coupon is a claim on one stall, and five from one plus five from another is not
ten of anything.

**Blocked by:** None (can start immediately)

**Status:** done (`/v1/stalls/{nip05}` deferred — see below)

- [x] Totals are grouped by stall and currency, and no cross-stall total is offered.
- [x] Amounts are in minor units, with decimals alongside, so rendering stays the caller's decision.
- [x] No coupon is ever carried in a URL or query string.
- [x] A caller sees only what it holds; nothing is inferred about other stalls.
- [x] A probe reads back a real history and its figures match what the app shows for the same rows.

## What it took

`@imani/reports`, extracted from `src/lib/stats.ts` by moving the file rather
than copying it, so there is one implementation. The 18 existing tests moved
with it and passed unchanged, which is the signal that behaviour was preserved
rather than redefined. `src/lib/stats.ts` is now a re-export, because every
screen already imports from that path.

`ReportTransaction` is declared in the package rather than imported from
`src/lib/transactions`, which would have made the package depend on the app —
defeating the extraction, since the API cannot import from `src/lib`. The app's
own type is structurally assignable, so every existing call site typechecks
unchanged.

**`direction` is derived from `type`, never read off the caller's row.** The
app does the same in `toTransaction`, whose comment records why: the stored rows
disagree with themselves. Over HTTP it matters more — a caller marking its own
issuance as incoming would inflate every figure in its own report. Both a unit
test and a probe arm cover it.

**`/v1/stalls/{nip05}` is not built.** Resolving a stall is `/api/v1/resolve`
on account-app, which is the same "locate the service" problem as tickets 06,
08 and 10 — and it is a GET of a public handle, so it does not share the
state-in/state-out shape the two report endpoints have. Better as part of that
group than smuggled in here.

## Evidence

14 endpoint tests, 18 in the package, and a 13-check probe against the running
service.

The probe's value is not the arithmetic — that is unit-tested — but the round
trip: JSON, a signature, a parser that derives direction for itself, and back.
It computes what the APP would show from the same rows and requires the API to
match, so a divergence fails rather than being discovered by a merchant.

One arm is a control: the same history re-sent with every row relabelled
`direction: 'in'` produces identical figures.

A tsconfig finding, fixed here: `tsconfig.services.json` declared no `paths`, so
`@imani/wallet-core` had been reporting TS2307 for as long as the service has
existed — the service is RUN by tsx, which resolves through vite's aliases, and
typechecked by a project that could not. Adding the paths fixes five of those
and reveals what they were masking: once the modules resolve, their types apply
and the service's own tests stop being `unknown`. That backlog is now visible
rather than hidden behind an unresolved import.
