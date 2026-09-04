# 03: Payment requests always name the stall as recipient

**What to build:** A request for payment names the stall's own key as the
recipient of whatever comes back, whoever is signed in on the device displaying
it.

Takings are gift-wrapped to the recipient's key, so a device that named itself
would collect coupons its owner cannot decrypt. That is money stranded on a
device, and it would make withdrawing a device's access a way to destroy funds
rather than only access. A terminal is an instrument for asking for payment, and
never a place money rests.

This is verifiable today, before any terminal exists, because the property is
about the request rather than about who built it.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] A payment request names the stall's key as recipient.
- [x] The recipient does not change when the signed-in key is not the stall's.
- [x] Takings arrive decryptable by the stall.
- [x] A stall taking payment on its own device behaves exactly as it does today.

## What it took

`createRequest` took `issuerPubkey: string` and every caller passed its own
session key — correct on the owner's device and silently wrong on a terminal. It
now takes the same `Actor` issuance does, and reads the recipient through
`issuingStall`.

That is the difference between documenting the rule and enforcing it: there is
no longer a field in which a caller could put a different key. The test that
passes `issuerPubkey` anyway carries a `@ts-expect-error` and asserts the
request still names the stall.

The stakes are why it is worth the structural change rather than a comment.
`lib/pay.ts` sets `recipientPubkey` from the request's `issuerId`, and the
atomic-send saga gift-wraps the token there — so a request naming the device
would send takings to a key the owner cannot decrypt. Revoking that device would
then destroy funds rather than only access, which is precisely what "a terminal
is an instrument for asking, not a place money rests" exists to prevent.

## Evidence

7 tests. One asserts the disposable key appears NOWHERE in the encoded request,
not merely that `issuerId` is right, so a future field cannot quietly
reintroduce it.

Mutation control: making the request name the terminal instead of the stall
fails 4 tests.

Note the tests stand in for `window.NUT18V` — the real encoder is imani-apps'
classic script loaded by `main.tsx`. The assertion is on WHAT WE ASK IT TO
ENCODE, which is the thing this ticket is about; the encoder's own wire format
is covered by the fields matching `VoucherPaymentRequest.java`.
