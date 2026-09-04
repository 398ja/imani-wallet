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

**Status:** todo

- [ ] A caller holding only a key can issue a coupon, with no cookie and no shared secret.
- [ ] The coupon names the CALLER as issuer, and its issuer signature verifies.
- [ ] The endpoint returns an id immediately rather than blocking on the mint.
- [ ] The README names the wallet path and says why the portal path is not usable headlessly.
- [ ] The service cannot mint without the caller's signature — removing the forwarded header fails the request.
- [ ] A probe issues a REAL coupon against the live gateway and verifies the returned token.
