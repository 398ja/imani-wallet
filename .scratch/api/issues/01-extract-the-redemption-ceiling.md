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

**Status:** todo

- [ ] The check is a pure function; calling it twice with the same arguments cannot give different answers.
- [ ] The app's `checkRedemption` is reimplemented in terms of it, rather than beside it.
- [ ] A parity test asserts both agree across the boundaries: fresh, partially redeemed, exactly at the face, one minor unit over, already at the face, past it, and no signed face at all.
- [ ] Outgoing rows never consume the ceiling; a merchant's own issued row must not spend what a customer has not.
- [ ] A voucher with no signed face is unbounded rather than refused.
- [ ] The parity test fails when the app's `direction === 'in'` filter is removed.
