# 03: Issue a coupon

**What to build:** `/v1/issue/plan` (what minting would produce), and
`/v1/issue/gateway-request` (the exact bytes to sign). The caller signs, the
service forwards the signature verbatim, and the caller polls for the token.

**Courier through `/api/v1/wallet/vouchers`, not the portal.** This is measured,
not assumed: an unregistered keypair signing for itself mints a verified token
through the wallet path (201), and the same signer gets 500 on
`/api/v1/portal/vouchers`, which `src/lib/issue.ts` uses. The portal is
authorised by a session cookie validated against account-app plus a shared
secret the browser never sees, so no headless caller can satisfy it. An
implementer following the app would lose a day to this.

The caller owns the poll. Minting returns PENDING behind a bolt11 top-up and
carries a token seconds later; the endpoint returns a `voucher_id` rather than
holding the connection. The caller must persist that id anyway to be crash-safe,
and a held connection is a timeout waiting to happen.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] A caller holding only a key can issue a coupon, with no cookie and no shared secret.
- [x] The coupon names the CALLER as issuer, and its issuer signature verifies.
- [x] The endpoint returns instructions immediately rather than blocking on the mint.
- [x] The README names the wallet path and says why the portal path is not usable headlessly.
- [x] The service cannot mint at all — it returns bytes and forwards nothing.
- [x] A probe issues a REAL coupon against the live gateway and verifies the returned token.

## What it took

A courier, and a smaller one than expected: the service returns a URL, a
method, and a body serialised once. It never calls the gateway, so it cannot
mint even by accident — which is a stronger position than forwarding a header
would have been.

**The path is the finding.** `/api/v1/wallet/vouchers`, not the
`/api/v1/portal/vouchers` the app uses. An unregistered keypair signing for
itself gets **201** on the first and **500** on the second, because the portal
is authorised by a session cookie validated against account-app plus a shared
secret the browser never sees. An implementer following `src/lib/issue.ts` would
lose a day to it, so it is named in the endpoint's own comment and in the test.

The response carries a `then` block saying the caller must poll for the token,
because minting answers PENDING behind a bolt11 top-up. The API does not hold
the connection: a held one is a timeout waiting to happen, and the caller needs
the voucher id persisted anyway to be crash-safe.

## Evidence

26 tests shared with ticket 04, and an 18-check probe.

The probe's decisive arm: a caller holding only a key signs the body this
service produced and sends it to the gateway itself — **HTTP 201**, then polls
as instructed, and the returned token parses with the caller as issuer and a
signature that verifies. That proves the bytes we hand out are bytes the
gateway accepts, rather than a plausible-looking URL.

Mutation control: emptying the forbidden-issuer list fails three tests.
