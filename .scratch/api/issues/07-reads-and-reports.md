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

**Status:** todo

- [ ] Totals are grouped by stall and currency, and no cross-stall total is offered.
- [ ] Amounts are in minor units, with decimals alongside, so rendering stays the caller's decision.
- [ ] No coupon is ever carried in a URL or query string.
- [ ] A caller sees only what it holds; nothing is inferred about other stalls.
- [ ] A probe reads back a REAL holding and its figures match what the app shows for the same rows.
