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

**Status:** todo

- [ ] A genuine unspent coupon verifies, and one already spent is refused with a reason that says which.
- [ ] A coupon from another stall is refused rather than redeemed at a stall that cannot honour it.
- [ ] The ceiling is enforced across presentations, not merely per presentation.
- [ ] A caller sending an inflated `signedFaceValue` cannot raise its own ceiling.
- [ ] The README states plainly that cross-redemption enforcement is only as good as the history the caller sends.
- [ ] A probe redeems a REAL coupon end to end against the live gateway, signed by a key the service never sees.
