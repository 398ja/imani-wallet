# Changelog

All notable changes to the Imani wallet are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.5.5] - 2026-09-18

### Fixed

Faults found reviewing the split-coupon and chunked-delivery work, each with a test that fails
without its fix.

- **Pieces of an already-received coupon were held forever.** Only the message that completes a
  split coupon is recorded as handled, so the earlier pieces are re-read on every poll by design.
  Each re-read started a new assembly that could never finish, because the piece that would finish
  it is the one the wallet will not look at again. Finished transfers are now remembered, and a
  coupon already in the wallet is not offered a second time. A transfer that FAILED to decode is
  deliberately not remembered, so a corrupted delivery can still be retried.

- **Half-assembled coupons outlived the session.** Those pieces are decrypted fragments of
  someone's money held in memory, and neither signing out nor switching account cleared them. Both
  now do.

- **Nothing checked that the parts of a split sale added up.** Each part reporting success is not
  the same claim as the customer receiving what was sold, and the gateway chooses the split. The
  confirmation screen now shows the amount actually delivered rather than the amount typed, and
  says plainly when the two differ. It warns rather than failing the sale, because those coupons
  are already with the customer and cannot be recalled.

### Changed

- The issuance result no longer offers a single-coupon field. Reading the first coupon as though it
  were the whole sale is precisely what delivered 200 of a 1000 sale, so the shape no longer makes
  that possible.

## [0.5.4] - 2026-09-18

### Fixed

- **Coupons that arrive split across several DMs are now reassembled, instead of vanishing.** A
  coupon whose token exceeds the gateway's direct-send limit is not sent as one message: it is
  split into `cashu_dm_chunk` pieces, one per gift wrap. Nothing put them back together. Each
  piece failed the token-envelope test, fell through to the legacy text parser, produced no token,
  and was recorded as "not a token DM" — which is marked processed and never retried. Coupons of
  200, 150 and 150 were minted, backed, delivered to the relay and acked, and never appeared in
  the recipient's wallet.

  The wallet had assumed the gateway reassembled them. It cannot: the chunk metadata is inside the
  encrypted message and the outer wrap carries only a recipient tag, so a server holding no
  private key cannot even tell a chunk from any other DM, and it refuses to guess. The client is
  the only place the pieces are legible. Reassembly now happens at unwrap time, verifying the
  declared length and SHA-256 before the coupon is credited, and an incomplete transfer leaves its
  pieces on the relay to be re-read rather than consuming them.

- **Coupons already abandoned are recovered.** Fixing the reassembly does not on its own bring
  back what was lost to its absence: those messages were recorded as "not a token DM", which is
  never retried, so the wallet skipped them forever. The gift wraps are still on the relay, so
  that local record was the only thing between the customer and their money. Each device now
  clears that record once, on the next start, and re-reads what it gave up on. Protection against
  crediting the same coupon twice is unaffected, because it keys on the token itself and is left
  untouched.

## [0.5.2] - 2026-09-18

### Fixed

- **Each coupon of a split sale is recorded at its own value.** The create and poll endpoints
  spell the amount differently (`face_value_minor` and `face_value`), so half the pipeline saw no
  amount at all, and the fallback filed the whole sale against every part — five rows of 1000 for
  a 1000 sale, reporting five times the money as delivered. Either spelling is now read, and
  failing both, the sale is divided by its part count.

## [0.5.1] - 2026-09-18

### Fixed

- **A split sale now delivers every coupon, not just the first.** The gateway breaks a face value
  whose Cashu token would exceed the transport ceiling into several smaller coupons and returns
  all of them. This app read only the first and discarded the rest, so a 1000-unit sale issued as
  5 coupons of 200 reached the customer as 200; the other four were minted, left pending, never
  polled and never delivered. A token carries one proof per set bit of its amount, so the ceiling
  is reached by ordinary round numbers rather than extreme ones, and any sale large enough to be
  split was silently short-paying the customer.

  A sale that fails part-way now FAILS LOUDLY, reporting the amount that already reached the
  customer. A delivered coupon is a gift-wrapped DM and cannot be recalled, so a later part
  failing cannot undo an earlier delivery — reporting such a sale as successful is what let the
  shortfall go unnoticed. The merchant's own history records one row per coupon at the part's
  value, and the confirmation screen says how many coupons a sale became, so the merchant and the
  customer count the same sale the same way.

## [0.5.0] - 2026-09-17

### Added

- **A merchant dashboard that prompts rather than reports.** "Expiring soon" now shows the three
  most urgent vouchers and links to the rest, so a glance answers "what needs chasing today"
  instead of scrolling past forty rows; the section is still absent entirely when nothing is
  expiring, because a box that says zero every day trains people to stop reading it. The full list
  is a new screen at `/merchant/expiring`, built from the SAME `expiringSoon` call the dashboard
  uses rather than a second filter written to match — two definitions would drift and the link
  would disagree with its own destination. "Vouchers you have issued" gained an "Expiring soon"
  count beneath "Still valid", the total it is carved out of.

- **Paging on every record list**, 21 to a page: transactions, vouchers, issued vouchers and the
  new expiring list. These were unbounded, which is fine for a customer holding three coupons and
  unusable for the stall that issued four hundred. The control strip renders nothing for a single
  page, disables rather than hides its ends so the other control does not jump, announces the page
  change to a screen reader, and does not glide the viewport for anyone who asked for reduced
  motion.

### Changed

- **A customer paying a merchant back now reads "Pay", not "Redeem".** "Redeem" is the merchant's
  word for value coming back off their books, and it stays that way on the till. The person at the
  stall is doing the ordinary thing of paying for something, and asking them to "Redeem" made them
  adopt the counterparty's accounting language for their own purchase — it also reads like claiming
  a prize rather than handing money over. Renamed across the whole customer leg, so the flow does
  not change its mind at the last screen. The underlying operation is untouched.

- **The dashboard balance no longer shows "Taken in".** It totalled the vouchers this wallet
  HOLDS, sat directly under a liability figure, and so read as income without being income. "Value
  taken" below already answers that question properly, over the chosen range and in the stall's
  issuance currency. Two numbers that both look like takings and disagree is worse than one.

### Fixed

- **The re-authentication prompt interrupted people mid-payment, every fifteen minutes.** The
  timeout was not too short; the client's clock had stopped agreeing with the server's. The gateway
  runs a SLIDING idle window and `/api/v1/auth/validate` pushes `expires_at` out to `now + idleTtl`
  on every authenticated request, so an active session is continually renewed and never reaches the
  deadline it was issued with. Nothing told the client: `expiresAt` is recorded once, from the login
  response, so the local watcher counted down from a snapshot the user's own traffic had invalidated
  seconds later and fired on a session the server considered perfectly healthy. Dismissing it changed
  nothing, because the next snapshot was just as stale. The local deadline is now a suspicion rather
  than a verdict — the wallet asks the gateway, and only a session the server AGREES is over raises
  the dialog. A dropped connection, a 502 or a 403 is none of those things and no longer prompts.

- **...and then the wallet kept itself signed in.** Found reviewing the fix above. Asking
  `/auth/validate` SLIDES the idle window as a side effect, so a client that asks whenever its local
  clock runs out renews its own session on a timer: a phone lying face-down on a café table stayed
  unlocked, with the 15-minute idle timeout enforced only by the server's 12-hour absolute cap. That
  is not a smaller bug than the interruption it replaced. The wallet now answers locally the question
  the server cannot — has a PERSON done anything since the last check — and only then confirms.
  Real input only, nothing the app can raise itself, and the signal is spent on read so one ancient
  tap cannot renew forever. Eight idle hours now produce zero renewals and a locked wallet, where
  before they produced thirty-two and an open one.

- **The prompt never arrived at the absolute cap.** Approaching the 12-hour ceiling the server
  clamps `expires_at` to the same fixed instant on every call. The expiry watcher fires on the
  TRANSITION only, so a confirmed deadline that had stopped moving latched it: the wallet never
  asked again and sat quiet against a session about to be refused, and the user's next tap would
  have failed with no warning. A floor under the confirmed deadline guarantees the next question
  gets asked.


- **The settlement receipt went to the wrong person.** On a merchant-issued coupon spent
  wallet-to-wallet, dmPoll addressed it to `meta.issuerId` — who MINTED the coupon, not who SPENT
  it — so the stall was told its own customer had been paid and the customer heard nothing. The
  payload carried the right answer in `sender_pubkey` all along and `dmCrypto` was dropping it; it
  is now parsed and preferred, with the stall kept as the fallback for the one case where it is
  right. The recipient also got only the optimistic advance notice, so six seconds after a payment
  the sole surviving record was the provisional one; settlement now files a bell row too. And the
  sender, watching the app when their payment was claimed, saw nothing at all — there is a toast
  now, deduped so a redelivery is silent. In-app notifications also honour the settings screen,
  which they had never consulted; the lookup fails open, because a preference that throws must not
  be what hides someone's money.

- **A phone could stop ringing without saying so.** Web Push endpoints are rotated, expired or
  dropped by the browser, and the `pushsubscriptionchange` event meant to announce that is
  unreliable and missing from several engines. Nothing re-registered afterwards, so the gateway
  went on pushing at an endpoint returning 410 while the settings screen still read "on" — a state
  that was permanent until the user toggled push off and on by hand. The current subscription is
  now re-POSTed on startup; the endpoint hash upserts, so an unchanged one is a no-op.

- **The recipient's phone stayed silent when a coupon arrived** (gateway-core). `notifyVoucherReceived`
  was fully implemented and called by nothing, while the sender's half of the pair had a caller and
  worked — which is why push looked healthy. Fixed in gateway-core; the wallet's inventory note is
  updated to match.

- **The send flow named people by hex key.** Every screen of it — the voucher picker, the amount
  screen, the confirmation — printed something like `a1b2c3d4…ef56` where a name belongs. Two
  separate causes. The MERCHANT was read from `Merchant.name`, which `VoucherGrouper` fills with
  `merchant_metadata.merchant_name || merchantId`; a coupon issued without that optional metadata
  therefore carried a 64-character key as its "name", which `humanName` correctly rejected and
  `identityLabel` then dropped all the way to a short key. Nothing ever asked for the kind-0 that
  was on the relay the whole time. The new `useMerchantLabel` / `useMerchantHandle` fetch it, and
  the published profile wins over the coupon's stored copy — that copy was taken when the coupon
  was ISSUED and never updates, so a stall that renames itself now reads as its new name on old
  coupons. The RECIPIENT kept its handle only until `toRecipientPubkey` threw it away: someone
  reached by typing `cocoa@staging.398ja.xyz` who has published no kind-0 left the flow with
  nothing to show but a key, for a person the user had just named. `resolveRecipient` returns the
  address it resolved through, and `IdentityInline` takes it as `fallbackHandle`. Both legs fall
  back exactly as before when there is genuinely nothing to show.

### Dependencies

- `@imani/dm-poll` 0.4.1 → 0.4.2 (adds `TokenMetadata.senderPubkey`).

## [0.4.1] - 2026-09-16

### Fixed

- **The 0.4.0 image would not build.** `undici` was added to `devDependencies` by the load-test
  work without a lock-file update, so `npm ci` in the Dockerfile refused the checkout as out of
  sync. The lock file now carries it. No runtime change.

## [0.4.0] - 2026-09-16

### Added

- **A stall can be reached by handle.** `/profile/cocoa`, `/profile/cocoa@imani.casa`, an npub or
  a hex key all open the same page, resolved the way the scanner and the paste box already resolve
  a recipient. A handle that resolves to nobody says so, rather than rendering an empty profile for
  a name that does not exist.
- **Show code.** Beside Copy on a stall's card, a button that holds up the stall's full handle
  (or its npub, when it publishes none) as a QR code, white-backed in every theme because a
  scanner reads dark-on-light. Both are 44px round targets, the same as on your own profile card.

### Fixed

- **A stall owner was offered a card purchase of their own voucher.** Opening your own profile,
  from your own coupon, receipt or a link that came back round, showed the Buy button. The page
  now knows who is looking: the purchase control is withheld on your own stall, and a line says
  that this is how the stall looks to a shopper.

### Changed

- Load-test notes record the second staging run, what it cannot measure, and why the first
  rate-limit fix was wrong (`loadtest/`).

## [0.3.2] - 2026-09-15

### Fixed

- **Scanning a QR code did nothing.** A customer's NIP-05 code from `/receive` and a merchant's
  `vreqA…` payment request behaved identically: the camera opened, the preview ran, the scan
  region drew its outline over the code, and the app never moved.

  The broken part was one word in a response header this repository ships. `qr-scanner` decodes
  in a Web Worker it builds from a Blob URL, and `deploy/nginx.conf` sent `worker-src 'self'`,
  so the browser refused the worker and the library never produced a result. The only trace was
  a console line, on a phone, where nobody is looking.

  Two CSP headers **intersect** rather than override, so the edge already allowing `blob:` could
  not rescue this: the strictest of the two wins, and the strictest was ours. `script-src 'self'`
  is unchanged, so injected script still cannot run or be packaged into the worker.

  Nothing in the unit suite could have caught it — the scan router, the QR handlers and
  `/api/v1/resolve` were all correct. `npm run e2e:scan` (`e2e/probe-scan.mts`) now plays a QR
  code into the real deployed app as a fake webcam and asserts the app actually moves;
  `deploy/__tests__/csp.test.ts` is the cheap guard on the header itself.

- **A blocked QR decoder now says so.** The header above is repaired, but it is not the only
  header in play: this app is served behind an edge proxy, can be served behind someone else's,
  and runs in a WebView with its own policy. Two CSP headers intersect, so any of them can break
  scanning on a deployment where our own file is correct.

  Both scanning screens therefore ask, before opening the camera, whether the page may run the
  decoder, and name the cause and the fix when it may not. The Scan screen reveals its typing
  field at the same time, because a blocked decoder is exactly when the fallback matters.

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
