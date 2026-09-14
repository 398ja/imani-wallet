# Changelog

All notable changes to the Imani wallet are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.1] - 2026-09-14

### Fixed

- **`audit-api` could not start: the image imported a file it never copied.** The IW-04 fix gave
  this service the bounded replay/rate store by importing `expiringMap` from
  `services/wallet-api`, but `services/audit-api/Dockerfile` copies only this service's own
  directory — so the container died in a MODULE_NOT_FOUND loop and came up unhealthy on staging.

  Nothing in the pipeline covers that gap. It is not a compile error, not a test failure and not
  a scan finding: 4,607 tests, three scanners and a cold-boot job were all green on the commit
  that introduced it. It only appears when the image runs, which is an argument for deploying to
  staging as part of a release rather than after one.

## [0.3.0] - 2026-09-14

The application-security review of 2026-09-13 (`imani-docs/security/appsec-2026-09-13/`) raised
17 findings against this repository, 1 Critical. All are closed.

**Minor, not patch: the services now refuse to start on an insecure relay URL in production.**
See "Upgrading" below.

### Security

- **IW-07 (Critical) — the debt-queue response was trusted verbatim**, so unvalidated input
  decided **how much value is minted**. Schema-validated before any minting now.
- **IW-01 — the NIP-98 audience was derived from the attacker-controlled `Host` header.**
- **IW-02 — free identities defeated per-key throttling**, and rate-map exhaustion silently
  disabled it.
- **IW-03 — idempotency keys were not bound to the request**, so one key replayed another
  endpoint's body.
- **IW-04 — replay protection was per-process**, so any scale-out silently re-admitted captured
  requests.
- **IW-05 — a caller-supplied `now` overrode the server clock on every expiry check.** The
  Semgrep rule written for this then found it in `reports.ts` and `requests.ts`, two files the
  review had not reached, one of which drives expiry.
- **IW-06 — the `/v1/redeem/check` ceiling was self-attested**, and negative prior redemptions
  were accepted.
- **IW-08 — the credential vault authenticated the key but not the identity it is bound to.**
- **IW-09 — decrypted issuing keys were cached for the process lifetime with no zeroisation.**
- **IW-10 — unauthenticated `/health` echoed internal failure detail.**
- **IW-11 — `audit-api` read the relay over cleartext `ws://` by default.**
- **IW-12 — no rate limiting on an unauthenticated CORS-wildcard endpoint doing curve work.**
- **IW-13 — no Content-Security-Policy anywhere in this repository.**
- **IW-14 — `privkeyHex()` handed out an unwipeable string**, defeating the eviction guarantee.
- **IW-15 — terminal enrolment records were stored unauthenticated in `localStorage`.**
- **IW-16 — `enrolledActor()` compared a field with itself**, so the device-lock check could
  never fail — under a comment asserting the comparison it could not make.
- **IW-17 — two high-severity production advisories with fixes available.** `npm audit` now gates
  the production tree in CI, and that gate *does* fail the build.

### Fixed

- **The IW-11 relay guards refused to start the shipped containers.** They threw at module load
  on a cleartext relay URL, and both Dockerfiles set `ENV ..._RELAY_URL=ws://nostr-relay:7777` —
  so the guard refused to start the very images it was protecting. A security control that stops
  the service working gets reverted wholesale, and the finding comes back with it. Now loud
  everywhere, fatal only in production.
- **`stallLookup.ts` read over cleartext `ws://`.** The comment above it already said an empty
  result "would read as 'not a stall' and allow exactly the send this module exists to refuse".
  Found by the new rules.

### Added

- `.semgrep/` with 6 TypeScript rules derived from real findings here, fixtures proving each
  still fires, and a CI check that fails when a rule matches nothing.
- gitleaks over full history with custom rules for nostr private keys, cashu tokens and LNbits
  admin keys.

## Upgrading to 0.3.0

**`AUDIT_RELAY_URL` is now mandatory — there is no default relay.** It previously fell back to a
hardcoded `ws://nostr-relay:7777`, so a misconfigured deployment silently dialled cleartext.

**In production a cleartext `ws://` relay refuses to start.** The guard fires when `NODE_ENV` or
`AUDIT_ENV` is `production`; elsewhere it warns loudly and continues. Point `*_RELAY_URL` at
`wss://` for any real deployment. For a local test stack only, `AUDIT_ALLOW_PLAINTEXT_RELAY=true`
is the written-down escape hatch.

Why it is fatal only in production: on a cleartext hop an attacker can drop one merchant of their
choosing from the stream, and this service then accuses that merchant of not having published.

**`npm audit` gates the production dependency tree in CI and fails the build.** Dev dependencies
are deliberately out of scope: they are numerous, they churn, and a vulnerability in a test runner
is not a vulnerability in the wallet a customer loads — gating on them means the gate gets
disabled, and a disabled gate protects nothing.


## [Unreleased]

## [0.2.0] - 2026-09-13

### Added

- **An expired session now asks for your passphrase instead of stranding you.**
  When the NAP session ran out, the app rendered `Signing in…` forever:
  `isAuthenticated` had gone false while the session object was still held, so
  the screen had no affordance on it and the only way back in was a page refresh
  the user had to think of for themselves. A passphrase dialog now opens over
  whatever was on screen, and unlocking returns them to it with no navigation
  and no reload. This is the flow imani-apps already had in `<reauth-modal>`,
  brought to the React wallet.

  Three pieces:

  - `lib/sessionExpiry.ts` — the local clock nap does not have. nap records
    `expiresAt` and then leaves it alone, so a wallet sitting idle on the
    coupons screen makes no requests and notices nothing until the user's next
    tap fails. This fires at the deadline the server already gave us, slightly
    early so a request in flight cannot lose the race, and re-checks on
    `visibilitychange` because a backgrounded tab throttles timers.
  - `lib/reauth.ts` — decrypt the stored key with the passphrase (the keystore
    is the verifier; there is deliberately no cheaper one), restore it if a lock
    evicted it, then `login()` for a fresh cookie. Deliberately not a silent
    renewal: the key is usually still in the signer and `login()` would go
    straight through, but a session that any open tab renews by itself is not a
    session lifetime — it is an unbounded one.
  - `components/ui/ReauthDialog.tsx` — modal, but never a dead end. A passphrase
    prompt is useless to the one person most likely to be reading it, so the
    other ways out are on the dialog: restore from a backup (nsec, file, Drive)
    and log out, one level deeper so the destructive one is not beside the
    button people mean to press.

  The dialog wears the app's own `.material` — the same translucent layer as the
  header and the menus — over a scrim that dims and pushes the content back, and
  settles down onto its resting size rather than growing from a trigger it does
  not have. Reduced motion keeps the cross-fade and drops the scale, rather than
  jump-cutting the whole viewport.

### Fixed

- **Restoring another account from the dialog ran as the previous identity.**
  The restore exit called `onLoggedOut()`, which is only `setSession(null)` — a
  React state change. The nap session lives in a module singleton outside React,
  and `createSession` returns the existing session while ignoring the key it is
  passed, so unlocking a backup handed back the *previous* account's session:
  authenticated as one identity while the keystore held another, with that
  identity's roles and its pubkey on every signature, and no error anywhere. It
  now calls `resetSession()`, the same guard `onUnlock` already applies to a
  failed login. The same fix stops the DM poller and the notifications loop,
  whose lifetime is the session rather than the component, so neither runs on
  past the account it belongs to.
- **A dismissed prompt silenced the next session loss.** The dialog closes the
  instant a correct passphrase lands, ahead of `NapProvider`'s 500ms poll, but
  the suppression was unconditional — so a later loss whose deadline had not
  arrived (a revoked cookie, which the timer never sees) stayed silent and put
  the user back on the dead screen. The dismissal is now paired with the
  authentication state it was made in.
- **The caret did not return to the passphrase field after a wrong attempt.**
  The focus call sat in the `catch`, where the field is still `disabled` —
  `busy` is cleared in the `finally`, after — and `.focus()` on a disabled input
  silently does nothing.

## [0.1.2] - 2026-09-11

### Fixed

- **The SPA builds again.** `tsc -b` failed on the receipt tests, so
  `npm run build` failed, so no image could be built from this checkout — the
  SPA, audit-api, purchase-issuer and wallet-api all ship from it. The mocks
  were bare `vi.fn()`, making `mock.calls[0]` a zero-length tuple that no `as`
  cast can widen. Each mock now carries the real parameter list of the function
  it replaces, so the assertions check the call rather than assert its shape
  (#81).

## [0.1.1] - 2026-09-11

### Fixed

- **wallet-api: the scheme now comes from the edge, not the socket.** Behind a
  TLS-terminating proxy every authenticated request answered 401 `url-mismatch`.
  NIP-98 binds a signature to an absolute URL and the comparison includes the
  protocol, so a caller signed `https://` while the service reconstructed
  `http://` from `req.headers.host`. `X-Forwarded-Proto` is now read, which
  grants nothing: it only lets a caller match a signature it already made over
  the URL it really used. This is the release that lets wallet-api be deployed
  at all (#79).

## [0.1.0] - 2026-09-11

The first numbered release. 431 commits, previously shipped as `:latest` with
`version: "0.0.0"` in `package.json` — so a container running in staging could
not be traced back to the code inside it.

0.1.0 rather than 1.0.0 deliberately: the wallet moves real money and the
number should say what it is, not flatter it.

This entry does not reconstruct those 431 commits. It starts the record here,
and the notification work below is what happens to be newest.

### Added

- **A sender learns their coupon was claimed.** The gateway had the whole
  mechanism — the receipt endpoint, an Artemis queue, a "Voucher Claimed" Web
  Push, VAPID keys, four registered subscriptions — and `push_notification_log`
  held zero rows, because nothing in this wallet ever posted a receipt. The word
  `payment-receipts` appeared here exactly once, in a comment.

  The receipt is NIP-44 encrypted to the sender, so the gateway relays a blob it
  cannot read. Its id is deterministic, so a retry collides and the gateway
  answers `409` rather than notifying twice for one claim.

- **Receipts are collected**, so a claim reaches the in-app bell and not only a
  push the user may have dismissed, denied, or never been asked for. The two
  routes dedupe on the gateway's receipt id.

### Fixed

- **Amounts are formatted, not interpolated.** Face values are minor units, so a
  72p claim rendered as `72`. Now uses the same `formatFace`/`displayDecimals`
  pair as the arrival toast, so the two notifications for one coupon agree.

- **A receipt no longer asserts an unverified amount.** `dmCrypto` is explicit
  that envelope fields are sender-written — "a genuine low-value token could be
  announced at any face value at all" — and the wallet already refuses to sign
  an attestation over one. A notification claiming "£500 was claimed" was the
  same unfounded claim in a friendlier place. Amounts now require a verified
  voucher signature; without one the receipt names no number.

- **The receipt is addressed to the issuer**, not to whoever signed the gift
  wrap. The gateway signs on a merchant's behalf, so the settlement was reaching
  the gateway while the merchant owed the news heard nothing.

- **`deliveryEventId` survives redemption.** It was set on the TokenDm and
  dropped when building the redemption options, so the receipt had no id to key
  on. There are two call sites in `dm-poll`; the fix landed on the one the
  service does not drive before being found on the one it does.

- **The dev proxy routes `/api/v1/payment-receipts`** to gateway-core. Without a
  rule it fell into the `/api` catch-all, reached customer-wallet and 404'd —
  the third time that trap has been hit in this file, and now the first that is
  tested for.
