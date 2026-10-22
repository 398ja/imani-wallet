# End-to-end checks

These drive the **real app in a real browser** against the live `imani-test`
stack. Everything else in this repo mounts components in jsdom, which proves
the component and not the product: jsdom cannot catch a broken route, a page
that throws on mount, an import only the bundler resolves, or CSS that does
not apply.

## Running

```sh
docker compose -f ../imani-deploy/docker-compose.test.yml up -d   # the stack
npm run dev -- --port 5177                                        # NOT preview
npm run e2e                                                       # terminals
npm run e2e:purchase                                              # card purchase
```

The **dev server, not `vite preview`**: the API proxy that registration needs
is defined in `vite.config.ts` and preview does not apply it. Hitting preview
gets you a redirect to `/onboarding` and nothing else.

## What it covers

A merchant registers for real against the gateway, then the terminal screens
are driven by clicking. 51 checks, spanning terminals 05-10 and subscriptions
07-08.

The suite was written partway through the work, so it was afterwards extended
BACKWARDS over the tickets that predated it — role gating, the dashboard
guard, decommissioning, and the subscription diagnostics screen. Ticket 07's
gating in particular had never run in a browser before that: it was
unreachable until ticket 10 wired the login, and the wiring is exactly what a
component test cannot check.

Notably it checks things unit tests structurally cannot:

- clicking a `<label>` focuses its input (the `htmlFor` fix)
- `prefers-reduced-motion` actually suppresses the confirmation animation,
  **and** that it animates without the preference — so the check cannot pass
  by the class never being applied
- no uncaught page errors at any point
- that a terminal cannot reach `/merchant/dashboard` by TYPING the URL, which
  is the control rather than the courtesy — verified separately from the menu
  being hidden, because those are two different guards and either could rot
- that the owner's own device is unaffected by every terminal rule, checked
  after each one

## What this found

Running it for the first time immediately surfaced a real defect that every
unit test had missed: registration failed with HTTP 500 because
`application.yml` in imani-gateway-core spelled the password fallback
`MERCHANT_IDENTITY_BOTTIN_PASS` instead of `..._PASSWORD`. The username
resolved and the password did not, and a Bottin client with one and not the
other disables itself. That is the class of bug only the real path finds.

## The mint probes

`e2e/probe-spend.mts` answers a question no mock can: does NUT-07 checkstate
SPEND a credential? Ticket 10 requires that verification never spends, and
`credentialRevocation.test.ts` only proves our code does not *call* receive.

```sh
MINT_URL=http://localhost:27777 npx tsx e2e/probe-spend.mts
```

Observed 2026-09-04 against cashu-mint 0.35.0: three consecutive checkstate
calls on a real gateway-minted credential all returned `UNSPENT`. Checking is
non-destructive at the mint, not merely in our client.

The other half is gated, because it destroys what it spends:

```sh
# Mint a throwaway first — never point this at a committed fixture.
node scripts/mint-terminal-credential.mjs --stall-name imani-terminals \
  --device $(openssl rand -hex 32) --role redeem-only --out doomed.token
MINT_URL=http://localhost:27777 PROBE_SPEND=1 \
  PROBE_TOKEN=src/lib/__tests__/fixtures/doomed.token npx tsx e2e/probe-spend.mts
```

Observed: `receive` returned 200, and the following checkstate returned
`SPENT`. So revocation really is irreversible and global — the pair matters,
because "checking never spends" would also pass against a mint that ignored us
entirely.

## Locked (P2PK) coupons — issue #58

`probe-gateway-locked-redeem.mts` and `probe-receive-atomicity.mts` cover
self-custody end to end against the live stack: a coupon locked to the
customer's key, refused unsigned by the mint, spendable with their signature,
and the proofs it mints spendable again afterwards.

**What is wired, and what is not.** Locking works on issuance
(`recipient_pubkey` → `merchant_metadata.lock_key`) and the client signs on
`api.receive`, which covers redemption, burn and credential revocation. The
voucher *split* endpoint accepts witnesses too.

The gap is gateway-core's atomic-send saga, the client's ordinary pay path. It
forwards to the split endpoint from an `@Async` worker, so the originating
request's headers are gone; it persists the source token but has no witness
column and no customer key. Carrying signatures across that hop needs a schema
change and a decision about holding customer signatures server-side.

That gap is currently latent rather than live: nothing in production sets
`recipient_pubkey` on voucher creation, and `terminalMetadataJson` — the other
producer of a `lock_key` — is called only from tests. So no locked coupon
reaches the saga today. It becomes a real defect the moment either is switched
on, which is why the probes exist now rather than later.

## `postdeploy-staging.e2e.mts` — after every staging deploy

The browser half of the post-deploy suite; the server half (escrow states, gateway
logs, mint API, Flyway) is `imani-deploy/scripts/postdeploy/run.sh`, which runs this
file and reads the wallets it prints on its `CONTEXT` line. Run it through that script:

```sh
../imani-deploy/scripts/postdeploy/run.sh snapshot   # before any test traffic
../imani-deploy/scripts/postdeploy/run.sh all
```

Against the LIVE staging wallet (`E2E_BASE`, default `https://wallet.staging.398ja.xyz`),
it registers a merchant and two customers and drives: an EUR sale (#95); the receive,
its `rcv_` key and a re-submit under a new key answered `409 RECEIVE_ALREADY_SETTLED`
(#110, #119); a 3-voucher payment between customers, checked on the toast, the bell and
the Transactions list (#94, #106); and an 8-part payment back to the stall that issued
it (#110). Customer A logs in with a key the suite generates, so it can sign the #119
re-submit itself. A pays B everything it holds, so the bundle is always every coupon
whole (4 parts), and B's 8-part payback count is reported on `CONTEXT` as `payBackParts`
for `run.sh` to match against the stall's escrows.

Optional environment: `E2E_BASE` (the wallet URL) and `E2E_EXPECTED_BUNDLE` (the
`index-*.js` the deploy should serve; T0+ fails on any other). The browser runs in the
`en-GB` locale, because amounts are read off the screen.

Its first runs found imani-wallet#114, #122, #123, imani-wallet-lib#103 and
imani-gateway-core#112. Flakes it absorbs are on the test host: a crash-looping local
container churns Docker bridges and Chromium aborts loads with `ERR_NETWORK_CHANGED`,
so navigation and registration retry once, and each retry is reported.

## `probe-concurrent-redeem.mts` — two coupons at one till at once (#145)

A till must book each coupon against its own voucher, even when two customers pay it in
the same instant. Before 0.11.1 two overlapping redeems could swap stamps, so one voucher
carried two rows for one redemption and its owner's last honest payment was refused as
"already spent".

```sh
E2E_BASE=https://wallet.staging.398ja.xyz E2E_ROUNDS=3 npx tsx e2e/probe-concurrent-redeem.mts
```

It registers a till and two customers. Each round, the till sells each customer a EUR 10
coupon of its own voucher, then both customers pay part of it together, then the rest
together. The till stays on its home screen, online, so both coupons arrive over live SSE,
the only path that redeems without waiting. It checks that every payment lands and each
customer ends at zero, that the till shows no refusal (toast or console), and, from the
till's own IndexedDB, that every incoming row is stamped with the voucher its coupon was
signed for and that each voucher has exactly its two redemptions.

To prove the probe still catches the bug, run it against an old build. `E2E_BUNDLE_DIR`
serves the app from a local `dist` while the API, relay and mint stay live:

```sh
git worktree add ../w0110 v0.11.0 && (cd ../w0110 && npm ci && npm run build)
E2E_BUNDLE_DIR=../w0110/dist npx tsx e2e/probe-concurrent-redeem.mts
```

On 2026-10-01 against staging, 0.11.1 passed 44 of 44 checks over 3 rounds, and 0.11.0
failed 7 of 44: two refused honest payments ("already paid out 800 of 1000; refusing a
further 600"), and rows stamped with the other customer's voucher. A failed run leaves a
screenshot of each wallet in `E2E_SCREENSHOTS` (default `e2e/.probe-concurrent-redeem`).

## `probe-cashback-spend.mts` — a cashback spent back at the stall that issued it

A cashback coupon must be spendable at the merchant who issued it, and the merchant must learn
it was claimed (imani-gateway-portal#52, #53; imani-wallet#144).

```sh
E2E_BASE=https://wallet.staging.398ja.xyz npx tsx e2e/probe-cashback-spend.mts
```

A till issues a EUR cashback code on `/sell/cashback`, and a customer redeems it on
`/receive/cashback` and pays the whole balance back to the till. (Out of date since typed codes
were retired, wallet#268 phase 1: the till's screen shows no code and `/receive/cashback` takes
none. The cleanup phase ports this probe, `probe-cashback-sev1` and `probe-spend-order` to the
link path.) It checks:

- the generate request carries an issuance warrant;
- the response returns the voucher id;
- the customer's coupon carries the warrant inside its signed secret;
- the till books the payment against that voucher, with no "Coupon not authorised";
- the portal's stored record (`GET /api/v1/portal/cashback/{id}`) turns Claimed on its own;
- the till's Vouchers list shows the cashback.

The claim check reads the stored record, not `/status`, because `/status` reconciles with the
claim service on every read and so reads Claimed even when no notification arrived.
`E2E_SKIP_CLAIM_STATUS=1` skips that check.

On 2026-10-01, before the fix, staging failed 9 of 15 checks. It reproduced the original
refusal ("carries no usable authorisation from the stall that issued it", toast "Coupon not
authorised"). The stored record stayed Unclaimed, and the Vouchers list said "None yet."

## `purchase.e2e.ts` — the card purchase

Written after a shopper's card was refused inside Stripe's hosted checkout
(400 on `/v1/payment_pages/.../confirm`) because the stall's connected account
had never been asked for the `card_payments` capability. `transfers` alone set
`charges_enabled`, so every flag we stored said the stall could sell.

`BuyPage` and `purchase.ts` both promise, in prose, that everything refusable
is decided BEFORE the customer sees a card form. That promise was false and
nothing held it, because holding it needs the real screen, the real proxy, the
real controller and the real account state at once.

So it asserts the REFUSAL LANDS ON OUR SCREEN — a stall that cannot take a card
fails on the Buy page, in our words, with no navigation to `checkout.stripe.com`
— rather than asserting a payment completes. That needs no fully-onboarded
Stripe account, so it still runs in CI; and completing Stripe's own form would
require a bank account and TOS acceptance no script can supply, besides testing
Stripe's DOM rather than ours.

Verified by mutation: flipping `charges_enabled` back to true in the test
database reproduced the incident exactly, landing the browser on a real
`checkout.stripe.com` session that would 400 at confirm. 4 of 11 checks red.

## `claimLinks.e2e.ts` — a claim link never redeems on open (claim links phases 0 and 1)

`imani-docs/wallet/spec-claim-links.md`, section 7. A merchant issues cashback; the
harness builds the link from the portal's own generate response (`claimUrl#k=claimKey`) and checks:
a headless GET, a prefetch and a sessionless browser spend nothing (CL-BOT); the prompt names the
stall, the face and the claim-by date and redeems nothing while open; Decline leaves it unclaimed;
Accept tapped twice redeems once; a claimed, a revoked and the merchant's own link (CL-OWN) offer no
Add; a different account is offered it as its own; a returning device lands on Login and the parked
claim waits behind the prompt; and the hosted claim page is `no-store`, `no-referrer`, with no store
placeholder, handing off to this wallet.

```sh
# on the local gate (imani-deploy scripts/local-terminal-gate)
E2E_SCRIPT=claimLinks.e2e.ts E2E_CLAIM_HOST_VIA=http://127.0.0.1:$GATE_EDGE_PORT scripts/local-terminal-gate/run.sh e2e
```

`E2E_CLAIM_HOST_VIA` serves the deployment's claim host (`cashback_origins[0]`) from the gate's edge,
so a local run never reaches the real staging claim host. Omit it against staging itself.

## `claimLinksMerchant.e2e.ts` — the merchant's link and QR (claim links phase 2)

`imani-docs/wallet/spec-claim-links.md`, sections 4.1 and 7. The link is taken from
the merchant's own screen (Share link), never from the generate response:

- **CL-A**: the code stays beside the link, the QR is hidden until Show QR, a logged-in customer
  opens the shared link and adds it, their balance goes up, and the merchant's open screen flips to
  *"Claimed just now"* by itself.
- **CL-RACE**: two customers tap Add within 50 ms: one *"Voucher added"*, one *"already added"*, one
  `claimed` row in the claim service.
- **CL-OWN**: the merchant's own link is refused, stays `pending`, and gateway-customer's
  `voucher_redemption_receipt` has no row for its voucher.
- **QR-AGAIN**: after a reload the record page rebuilds the identical link from the code (the key is
  in no web storage), then Cancel cashback revokes it.

The portal's public metadata and by-code share a per-address limiter (10 a minute, then 429 for
300 s). The harness books its reads under 7 a minute and reads statuses from the databases, so it
never trips it. Needs `E2E_PORTAL_SQL_CMD` (the gate passes it).

**The edge bot check on by-code.** imani-deploy can run FCaptcha on
`/api/v1/portal/cashback/by-code/` (`nginx/conf.d/lua/captcha_gate.lua`). Playwright's Chromium is
scored as a bot, so once that gate is in `enforce` mode, QR-AGAIN and every probe that redeems a
code (`probe-cashback*.mts`, `probe-spend-order.mts`) need `E2E_CAPTCHA_BYPASS` set to the
edge's `bypass_secret`. `e2e/captchaBypass.mts` adds it to by-code requests only. A till never
calls by-code, so `terminalSetup.e2e.ts` registers it only as insurance. The bundle routes
(`E2E_BUNDLE_DIR`) pass `/fcaptcha/` to the network like `/api/`, so the widget comes from the
edge (or 404s) rather than the SPA shell. Unset, nothing changes (local stacks, observe mode).

```sh
E2E_SCRIPT=claimLinksMerchant.e2e.ts E2E_CLAIM_HOST_VIA=http://127.0.0.1:$GATE_EDGE_PORT scripts/local-terminal-gate/run.sh e2e
```
