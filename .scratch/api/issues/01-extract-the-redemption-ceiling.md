# 01: Extract the redemption ceiling, and pin it to the app's

**What to build:** The double-redemption check as a pure function of its
arguments, in a package both the app and the API can call. Given a signed face
value, an amount requested, and the prior redemptions of that voucher, say
whether one more fits.

No storage, no network, no clock. `checkRedemption` today calls
`listTransactions()` itself and reaches IndexedDB through `wallet.ts`, so a
stateless service cannot call it at all — this is not a tidy-up, it is the thing
that unblocks redemption over HTTP.

This ships no endpoint. It exists because the risk it carries is worth isolating:
an extracted copy that drifts leaves a till and an API enforcing different
ceilings on the same voucher, each internally consistent, and no test failing.
The parity test is the deliverable as much as the function is.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The check is a pure function; calling it twice with the same arguments cannot give different answers.
- [x] The app's `checkRedemption` is reimplemented in terms of it, rather than beside it.
- [x] A parity test asserts both agree across the boundaries: fresh, partially redeemed, exactly at the face, one minor unit over, already at the face, past it, and no signed face at all.
- [x] Outgoing rows never consume the ceiling; a merchant's own issued row must not spend what a customer has not.
- [x] A voucher with no signed face is unbounded rather than refused.
- [x] The parity test fails when the `direction === 'in'` filter is removed.

## What it took

`@imani/redemption`, following `@imani/licence`'s shape: a package precisely
because the interesting cases are arithmetic edges, and reaching them through
IndexedDB and a DM poller would make most of what a test asserts incidental.

`redemptionLedger` keeps what is genuinely local — which rows count, and how
direction is derived through `toTransaction`, since stored rows disagree with
themselves about it — and now owns no bound of its own.

**The parity test changed meaning, and got stronger.** It used to compare the
app against a reimplementation sitting beside it, which was the best available
check while the arithmetic lived inside `redemptionLedger`, and never
satisfying: agreement today is not identity tomorrow, and the drift it guards
against is silent by construction. Now `checkRedemption` CALLS the package, so
those tests pin that the app has not grown a second implementation — a stronger
property, and a cheaper one to keep true.

`PriorRedemption` is deliberately not the app's `TransactionRow`. That type
carries a dozen fields this arithmetic must not see, and depending on it would
drag storage's shape into a package whose whole point is not having one — and
into an API request body, where every extra field is something a caller could
lie about to no effect.

## Evidence

15 package tests, 10 in the app, 9 parity. The app's existing redemption tests
passed UNCHANGED against the extracted package, which is the useful signal:
the extraction preserved behaviour rather than redefining it.

Mutation control: dropping the `direction === 'in'` filter fails 3 tests across
both the package and the app — including "is not raised by an outgoing row,
however large", which is the case a caller could otherwise exploit by sending
its own issuance as history.

One non-obvious decision, tested: a malformed amount contributes zero rather
than poisoning the sum to `NaN`. A `NaN` total makes every comparison false, so
`allowed` would come back TRUE and one bad row would silently disable the
ceiling entirely.
