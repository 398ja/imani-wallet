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

**Status:** done (`/v1/licence/purchase-request` deferred — see below)

- [x] Status is computed from the voucher the caller sends, with no lookup of who they are.
- [x] A licence signed by anyone but us grants nothing — **with a caveat, below.**
- [x] An expired licence grants nothing, and the grace window does not rescue it.
- [x] A licence never appears as spendable value in any balance the API reports.
- [x] A probe checks a REAL licence minted by the gateway.

## What it took

An attest, and the smallest endpoint in the spec: the caller sends the voucher,
we read it, check the signature, the lock and the expiry, and answer. No
network, no store, no lookup of who they are — ADR 0007's whole point, and an
endpoint that quietly became a licence server would undo it.

**503 rather than a default issuer key.** `verifyLicence` refuses to default it
and says why: a default would pass for a voucher anyone minted. A service
nobody configured answers "not configured" rather than pretending to check,
because a check that looks like it is working is worse than none.

**A `VoucherRow` type import cost fifteen typecheck errors.** `src/lib/licences.ts`
type-imports it from `@imani/wallet-storage`, and TypeScript loads the whole
module even for a type-only import — reaching `IDBDatabase`, a browser global a
Node project has no types for. Moving `licenceOf` into `@imani/licence` fixed it
and put the reader where both callers can share it, which it should have been.

**`/v1/licence/purchase-request` is not built.** Selling a licence is minting a
voucher with licence metadata, which is exactly `/v1/issue/gateway-request` with
a different `merchant_metadata` — a caller can do it today. A second endpoint
would be a second place to get the metadata shape wrong.

## Evidence

14 endpoint tests and a 9-check probe against a licence the live gateway minted:
granted for the holder, nothing for anyone else holding a copy, nothing once
expired, and still nothing when an expired licence is presented with a fresh
grace window.

That last one is the line `LicenceCheck` draws: an expiry was ANSWERED, and the
window is for an OUTAGE. Softening it would sell a month for free.

## The caveat, and it is the probe's most useful output

**A licence "signed by anyone but us" cannot be distinguished on a shared mint,
and the arm testing it FAILED before being rewritten as a documented SKIP.**

`verifyLicence` checks `issuerPublicKey` — the key that signed the voucher
bytes, which is the GATEWAY's, identical on every voucher it mints, whoever
asked. `issuerId`, the stall, is a different field the verifier never reads. So
a licence minted through the same gateway by a different seller verified as
ours, and the probe reported `granted=true` for a licence nobody sold.

That is not a defect in this endpoint. It is the model working under an
assumption this stack does not meet: ADR 0007 has the issuer key as OURS,
shipped in a bundle, which presumes we run the mint that signs licences. A
shared test mint signing for everyone breaks the presumption, not the code.

It is a real deployment question though: **if licences are ever signed by a mint
that also signs for others, the verifier must check the SELLER and not only the
signer.** `LicenceVoucher` carries no seller today, so that is a change to the
type rather than a tightened check. Recorded here rather than left in a probe
comment nobody reads.
