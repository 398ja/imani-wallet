# 09: Subscription status

**What to build:** `/v1/licence/status` (what does this licence entitle me to?)
and `/v1/licence/purchase-request` (the bytes to sign to buy or renew).

Status is an attest and maps almost unchanged: `licenceStatus` is already an
offline verification over a voucher the caller holds, with no network. That is
ADR 0007's whole point — no licence server, no phone-home, no honeypot of
who-runs-what — and the endpoint must not quietly become one.

An automation that can ask "is this feature available to me?" before it tries is
the reason to bother: the alternative is discovering a lapse through a failure
mid-workflow.

A licence is never money. It carries a face value like any voucher, and the API
must not report it as a balance.

**Blocked by:** None (can start immediately)

**Status:** todo

- [ ] Status is computed from the voucher the caller sends, with no lookup of who they are.
- [ ] A licence signed by anyone but us grants nothing, however well-formed.
- [ ] An expired licence grants nothing; one inside its grace window still serves.
- [ ] A licence never appears as spendable value in any balance the API reports.
- [ ] A probe checks a REAL licence minted by the gateway.
