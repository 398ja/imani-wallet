# 02: Redeem a coupon

**What to build:** The three endpoints a till needs to take a coupon:
`/v1/redeem/verify` (is this coupon genuine, unspent, and honoured by me?),
`/v1/redeem/check` (would this amount fit inside what was issued?), and
`/v1/redeem/prepare` (the gateway request to sign).

Verify is a plan and moves nothing. Check is an attest: the caller sends the
prior redemptions it holds and gets a verdict, because the service has no rows
of its own. Prepare is a courier, for the same reason the spend path is one —
the service holds no credential it could present to the gateway, and if it did,
that credential would be a way to redeem anything anyone sent it.

The bound never comes from the caller. `signedFaceValue` is read from the
verified voucher, so a caller that lies about its history still cannot lift the
ceiling above what the issuer signed.

**Blocked by:** 01

**Status:** done

- [x] A genuine coupon verifies, and a forged or expired one is refused with a reason that says which.
- [x] A coupon from another stall is refused rather than redeemed at a stall that cannot honour it.
- [x] The ceiling is enforced across presentations, not merely per presentation.
- [x] A caller sending an inflated `signedFaceValue` cannot raise its own ceiling.
- [x] The README states plainly that cross-redemption enforcement is only as good as the history the caller sends.
- [x] A probe redeems a REAL coupon end to end against the live gateway, signed by a key the service never sees.

## What it took

Three endpoints, because they are three different questions: `/v1/redeem/verify`
(is this real and mine to honour), `/v1/redeem/check` (would this amount fit),
`/v1/redeem/prepare` (what do I sign to take it).

**`verify` deliberately says nothing about whether the coupon is SPENT.** That
is the mint's answer, and asking here would turn a local check into a network
round trip at the slowest possible moment — a till asks this while the customer
is standing there. What the endpoint settles is that the bytes are genuine,
which is the part a caller cannot do for itself.

`src/lib/voucherToken.ts` is imported rather than reimplemented, joining
`audit.ts` in `tsconfig.services.json` for the same reason that file gives: a
second voucher parser would be a second opinion about somebody's money.

**A refusal answers 200, not 4xx.** The question was answered; the answer is
that this coupon must not be taken. A 4xx would mean the REQUEST was wrong,
which a caller fixes differently.

Two things that had to be got right and would have been easy to miss:

- **The receive endpoint is on customer-wallet (28082), not gateway-core
  (28081)** where the split courier points. Conflating them would send a caller
  to sign a URL the gateway never serves. It reads its own environment variable.
- **`src/lib/voucherToken.ts` used a constructor parameter property**, which is
  not erasable syntax, and the service typechecks under `erasableSyntaxOnly`
  because Node strips types rather than compiling them. Written out longhand.

## Evidence

17 endpoint tests and an 18-check probe against real artefacts.

The probe mints a REAL coupon through the live gateway, then verifies it, tries
it as another stall, tampers with it, walks the ceiling past its face, and
finally **signs the courier's body and sends it to the gateway** — which
answered HTTP 200 with `imported_count: 6`. That last arm is the one that
matters: it proves the bytes this service tells a caller to sign are bytes the
gateway actually accepts, rather than a plausible-looking URL.

Mutation controls, both run:
- removing the cross-stall check fails "REFUSES a coupon issued by another stall"
- making the ceiling trust a caller-supplied face fails "comes from the VERIFIED
  voucher, never the caller"

The second is worth recording: my first attempt at it mutated a field the
parser strips, so nothing failed and it looked like a gap in the tests. It was
a no-op mutation, not a weak test — but only running it showed that.

Also fixed: a pre-existing flake in `server.test.ts`. "refuses one from the
future" used `now - 61` against a 60-second window, so a single second passing
between signing and checking put the event back inside it. Observed failing in
a full run and passing alone. Now `-120`, with the boundary itself still covered
by the neighbouring test.
