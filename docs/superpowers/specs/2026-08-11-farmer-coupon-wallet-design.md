# Farmer Coupon Wallet — Design

**Date:** 2026-08-11
**Status:** Approved, in implementation
**Repo:** `imani-wallet`

## 1. Problem

Farmers selling directly to end customers at weekend markets sell coupons as IOUs, and later
redeem them for goods and services. They want to predict their sales volume with better accuracy.

This spec covers the **customer** side: a wallet that receives coupons from farmers and pays the
issuing farmer back with them. The farmer/merchant side already exists (POSSA Merchant) and is out
of scope.

## 2. Scope

A working prototype, not a polished product. The existing `imani-wallet` folder is reused as the
shell; its mock content is deleted.

**In scope:** farmer list, pay-by-QR-scan, receive-by-nip05-QR, farmer detail (balance, coupons,
transactions), real NAP authentication, real Cashu vouchers over Nostr, real local backend.

**Out of scope:** merchant/POS surfaces, i18n, PWA/service worker, push notifications, the offline
wallet subsystem, multi-voucher bundle splitting beyond what `VoucherSelector` provides, visual
polish.

## 3. Stack

Existing shell, kept: Vite 7, React 19, TypeScript 5.9, Tailwind 3, react-router 7.
Added: TanStack Query v5, Vitest (for the one check in §8).

This matches the target stack named in imani-apps spec `001-react-redesign`, so the prototype sits
on the sanctioned migration path rather than on a side branch.

Deleted from the current shell: `src/pages/merchant/`, `src/data/mockData.ts`,
`src/pages/auth/RegisterPage.tsx` (registration is bottin's job).

### 3.1 Package consumption

Packages are aliased to source in `vite.config.ts`. No build step. This is already nap's own
documented convention — every nap package points `exports` and `types` at `./src/index.ts` and
ships no `dist/`.

| Alias | Target |
| --- | --- |
| `@imani/nap-core`, `nap-client-web`, `nap-client-http`, `nap-client-nip46`, `nap-react` | `../nap/packages/*/src/index.ts` |
| `@imani/wallet-storage` | `../imani-apps/packages/wallet-storage/src/index.ts` |
| `@imani/nostr-vouchers` | `../imani-apps/packages/nostr-vouchers/src/index.ts` |
| `@imani/wallet-balance` | `../imani-apps/packages/wallet-balance/src/index.ts` |
| `@imani/nostr-transactions` | `../imani-apps/packages/nostr-transactions/src/index.ts` |
| `@imani/voucher-send` | `../imani-apps/packages/voucher-send/src/index.ts` |
| `@imani/profile-service` | `../imani-apps/packages/profile-service/src/index.ts` |
| `@imani/money` | `../imani-apps/packages/money/src/index.ts` |
| `@imani/gateway-client` | `../imani-apps/packages/gateway-client/src/index.ts` |
| `imani-qr` | `../imani-apps/packages/imani-qr/src/index.ts` |

Every `@imani/*` package is framework-agnostic plain TypeScript with zero React dependency, so
aliasing is safe. Because aliasing bypasses each package's own `node_modules`, their runtime
dependencies must be installed into this app: `nostr-tools`, `qr-scanner`, `@gandlaf21/bc-ur`,
`buffer`.

**Fallback if aliasing fights us:** switch the offending package to a `file:../imani-apps/packages/X`
dependency and run its `tsup` build. Per-package, not all-or-nothing.

### 3.2 The NUT-18V shim

NUT-18V voucher payment request parsing (`vreqA…`) lives in `imani-apps/shared/nut18v.js`. It is a
vanilla IIFE, not an extracted package. It ends with `window.NUT18V = NUT18V`, and
`imani-qr`'s `PaymentRequestHandler` looks the parser up as `globalThis.NUT18V`.

A bare side-effect import in `src/main.tsx` satisfies both sides:

```ts
import '../../imani-apps/shared/nut18v.js';
```

No port, no fork, no reimplementation of the CBOR codec.

## 4. Backend

`imani-deploy/docker-compose.test.yml` with `.env.test`, under its own compose project name so it
cannot collide with the `dalia-pilot` containers already running on this machine.

Host ports used by the wallet:

| Service | Host port | Role |
| --- | --- | --- |
| `account-app` (gateway-core) | 28081 | NAP auth, accounts. `NAP_ENABLED=true`, `NAP_COOKIE_SECURE=false` |
| `customer-wallet` (gateway-customer) | 28082 | Wallet ops, nostrdb-backed Nostr reads |
| `bottin-web` | 28086 | NIP-05 identity |
| `imani-mint-rest` | 27777 | Cashu mint |
| `edge-proxy` | 28080 | nginx front door |
| `nostr-relay` (strfry) | **added** | Nostr writes from the browser |

`docker-compose.test.yml` does not come up as written. Four defects had to be worked around, all in
`deploy/compose.override.yml` + `deploy/up.sh` in this repo, leaving `imani-deploy` unmodified.
These are real bugs in that compose file, worth reporting upstream:

1. **Three image references 404.** `docker.398ja.xyz/imani-vault-jpa`, `…/gateway-portal` and
   `…/phoenixd-mock` are not repositories in the registry. The real names are `cashu-vault-jpa`
   (this stack previously ran `staging/cashu-vault-jpa`) and `staging/gateway-portal` /
   `staging/phoenixd-mock`. Only the vault is on the customer path, so only it is overridden; the
   other two are simply not started.
2. **`customer-wallet` cannot start at all.** `WalletInternalController` takes a hard constructor
   dependency on `TokenDmTransferPort`; `TokenDmConfiguration` only supplies it when a
   `NostrGatewayService` bean exists; that bean only exists when nostr is enabled. The staging
   compose sets `GATEWAY_CUSTOMER_WALLET_NOSTR_ENABLED` and `…_NOSTR_RELAYS`, the test compose does
   not. Fixed by setting both, pointing at `ws://nostr-relay:7777`. The deeper asymmetry is that
   `TokenDmController` guards itself with `@ConditionalOnBean` for this exact case and
   `WalletInternalController` does not.
3. **The relay does not run.** `dockurr/strfry`'s entrypoint hard-codes `ulimit -n 1000000`, above
   this daemon's per-container max of 524288, so it exits(1) — the compose's own
   `ulimits: nofile: 524288` cap cannot help, since strfry requests the larger value itself.
   Switched to `ghcr.io/hoytech/strfry` (already running fine elsewhere on this host) with a
   mounted `strfry.conf` that sets `bind = "0.0.0.0"` and `nofiles = 524288`, because that image's
   default config is loopback-only. Same fix bottin's relay uses.
4. **`nostr-relay` publishes no host port** — "services reach this via docker DNS only." True for
   server-to-server, but the wallet is a browser app and Nostr *writes* go browser → relay directly.
   Published on 27778.

Also note: `customer-wallet` depends on `nostr-relay`, which has no healthcheck, so `depends_on`
does not wait for it and the service loses a startup race on a cold boot. Re-running `up.sh` after
the relay is listening settles it.

**Port 7777 is already occupied** on this machine by `dalia-pilot-cashu-mint-rest`. The test compose
maps the imani mint to 27777 and the compose project is namespaced `imani-test`, so the two stacks
coexist.

Vite dev-proxies `/api` → `localhost:28081` and `/customer` → `localhost:28082`. This keeps the NAP
session cookie same-origin and removes all CORS and `SameSite` work from the prototype.

## 5. Authentication and key custody

> **Revised 2026-08-11.** This section originally specified NIP-07 only, with the private key
> deliberately kept out of the page. That is incompatible with receiving coupons, and the wallet now
> holds the key. The reasoning is below because the reversal matters more than the conclusion.

**NAP is an authentication protocol. Its signer only signs.** `EventSigner` is `signEvent(template)`
and nothing else; `Nip07Provider` is documented as "the slice of `window.nostr` that NAP
authentication actually uses" — `getPublicKey` + `signEvent`. There is no NIP-44 decrypt anywhere in
nap's contract, and that is correct scoping, not an omission.

**Receiving coupons requires decryption.** A coupon arrives as a NIP-17 gift wrap, and unwrapping it
is two NIP-44 decrypts against the recipient's key. imani-apps' receive pipeline says the same thing
in its type: `DmPollConfig.recipientPrivkey: string`.

Sign-only signer + decrypt-requiring inbox = the key has to be reachable. So:

- **Signer:** `src/lib/signer.ts` — a local `EvictableSigner` holding the key. `EvictableSigner` is
  nap's own contract for exactly this: RFC §28.6 requires a lock to *zero* key material rather than
  merely flag state, so `clearKey()` wipes the bytes and `setKey()` restores them.
- **At rest:** nap's `createWebCryptoKeyStore` (PBKDF2 + AES-GCM, fresh salt and IV per write). RFC
  §1181 forbids plaintext key material at rest, `localStorage` included.
- **Lifecycle:** nap owns it. Passing `keyStore` makes `requiresPassphrase()` true and gives lock a
  real reunlock path; without it a lock would be unrecoverable for a key-holding signer.
- **Login:** unlock an enrolled key with a passphrase, or enrol an nsec on first use.
- **Registration:** in the wallet, as of 2026-08-13 — see §14. It used to belong to bottin, and that
  is no longer true.

The rejected alternative was NIP-07 for auth plus `window.nostr.nip44.decrypt` for unwrapping. It
keeps the key out of the page, but it reaches past nap's typed slice to the raw extension, depends
on the extension implementing nip44, and has no NIP-46 story since nap does not expose the bunker's
`nip44_decrypt`.

## 5b. Original NIP-07-only authentication (superseded)

`NapProvider` from `@imani/nap-react` wraps the router, backed by `createNapSession()` from
`@imani/nap-client-web`.

- **Signer:** NIP-07 browser extension when present; `@imani/nap-client-nip46` remote signer
  otherwise.
- **Flow:** challenge from `POST /auth/init`, NIP-98 signed completion to `POST /auth/complete`,
  opaque server-side session in an HTTP-only cookie.
- **TTL:** 15-minute sliding idle window, 12-hour absolute cap (gateway defaults).
- **Gate:** `useNapSession()` gates the whole app. Unauthenticated users get a bare screen whose
  only action starts the NAP handshake — the customer is assumed already registered via bottin.

The nsec-in-IndexedDB identity path lives in `imani-apps/shared/storage.js`, 10.5k unextracted
lines mixing four concerns. It is deliberately **not** used. NIP-07 and NIP-46 only.

## 6. Screens

| Route | Content |
| --- | --- |
| `/` | Wallet total, **Pay** / **Receive**, then a swipeable deck of farmer **passes** — one full-width card per farmer, swiped through and tapped to open. Vouchers read from IndexedDB, grouped by **issuer pubkey** using `VoucherGrouper`. Replaced a stacked list of name/avatar/balance rows: the pass is the farmer's identity, so recognising a card beats reading a truncated pubkey. See §13. |
| `/scan` | `createQrScanner()` from `imani-qr`. The detector routes `vreqA…` and `cashu:vreqA…` to `PaymentRequestHandler`. A clipboard-paste button is the fallback when the camera is unavailable. |
| `/pay` | Confirmation. Reached as `/pay?paymentRequest=vreqA…` — the same `paramKey` contract `imani-qr`'s router already uses, so scan and clipboard-paste share one entry point and the URL is replayable during debugging. Shows the parsed request: farmer, amount, memo, expiry. `PaymentRequestValidation` surfaces expired / insufficient balance / no matching voucher. Confirm hands off to **`api.initiateAtomicSend`** — see §11.6; `VoucherSender` was the original design and is not the path imani-apps itself uses. |
| `/receive` | QR code of the customer's own **npub**. Display only. The design said nip05; nothing in this stack can produce one — §11.6. |
| `/farmer/:pubkey` | The farmer's **pass**, carrying their total, and the 3 most recent transactions with **See all**. The pass IS the link to the coupon list — see §13. Superseded the earlier balance-panel-plus-capped-coupon-list layout, which showed the total twice. |
| `/farmer/:pubkey/coupons`, `/farmer/:pubkey/transactions` | The full lists, same row components as the capped ones. The coupon list is now one level deeper than it was, reached only through the pass. |
| `/coupon/:tokenId` | One coupon: its **pass** (balance, expiry, redemption QR), a visible summary (status, received, expiry, coupon id), and the technical record — sats **Backing**, backing strategy, issuance ratio, voucher id, issuer, terms, provenance — collapsed behind **Details**. Addressed by `token_id`, the store's content-derived primary key: `voucher_id` is a merchant *template* id shared between coupons and cannot address one. |
| `/transaction/:id` | One transaction: signed amount, type, date, memo, transaction id visible; raw type, counterparty and ids in **Details**. |

Account screens, added 2026-08-13 — see §14. Every authenticated route above now sits under a header
carrying the user's avatar, which is also the account menu.

| Route | Content |
| --- | --- |
| `/onboarding` | Public. Create an account (handle, passphrase) or enrol an existing nsec. |
| `/onboarding` → backup | Public-to-authed handover. The new nsec, once, with reveal / copy / download and a checkbox gating **Continue**. Rendered *instead of* the router, not as a route, so it cannot be navigated away from. |
| `/login` | Public. Recognition card — avatar, name, handle — plus a passphrase. Unlock only. |
| `/restore` | Public. Open a backup file, then unlock it with its passphrase. |
| `/profile` | The user's own profile as others see it. Farmers' profiles remain `/farmer/:pubkey`. |
| `/settings` | Profile, Security, Backup. |
| `/settings/profile` | Display name, about, photo, banner, website. Handle read-only. **No lightning address.** |
| `/settings/security` | Change passphrase, reveal/export the nsec behind the passphrase, log out. |
| `/settings/backup` | Download the encrypted backup file. |

Empty values are omitted rather than rendered as em-dashes — on this stack a DM-received coupon has
no expiry and no memo, so a fixed field list would be mostly blanks. Every list and detail screen
subscribes via `onWalletChanged`, so a coupon arriving or being spent updates the view in place.

## 7. Data flow

**Source of truth.** `WalletStorage` (IndexedDB, `imani-wallet-{userId}`) owns vouchers and
transactions. The UI subscribes to changes through the package's `broadcastChannel`.

**State ownership boundary.** TanStack Query caches *gateway REST reads only*. It never touches
IndexedDB, relay subscriptions, or coordinator state. Blurring this boundary is the specific failure
mode the imani-apps React migration doc warns about — it is how a React layer ends up duplicating
coordinator responsibilities and reintroducing duplicate-transaction and double-redemption bugs.

**Receive path.** Coupons arrive as NIP-17 gift-wrapped DMs from the farmer, driven by
`@imani/dm-poll`, which writes into `WalletStorage`.

**Pay path.** No payment logic in JSX — the migration doc's governing rule is never to rewrite a
coordinator in React, consume it. This originally named `VoucherSender` as the coordinator to
consume, which was the wrong one: imani-apps' own send screen drives `api.initiateAtomicSend`, and
`VoucherSender`'s unconditional split cannot complete against a self-custodial customer tier. The
rule held; the choice of coordinator was corrected in §11.6.

**Farmer identity.** A farmer is an **issuer pubkey**. Vouchers already carry it; no new concept is
introduced. Display name and avatar are resolved from that pubkey through `profile-service`.

## 8. Testing

One runnable check for the non-trivial logic, no framework ceremony: a Vitest unit test over the
farmer-grouping and balance-aggregation layer, asserting that vouchers from three issuers group into
three farmers with correct per-issuer totals. Payment itself is verified end-to-end by hand against
the live stack — that is the point of choosing the full real stack.

## 9. Risks

Ranked by what actually threatens delivery.

1. **Stack health is the schedule.** Fifteen services, four Postgres databases with Flyway
   migrations, vault seeding. If `account-app` or `customer-wallet` will not boot, there is no
   prototype. This is why it is built first.
2. **A real coupon must exist.** The farmer list is empty until a farmer issues a voucher to the
   test customer's pubkey. This requires driving POSSA Merchant or the gateway issuance API; a seed
   script covers it.
3. **Source aliasing across nine packages may surface transitive-import problems** — packages that
   assume their own `node_modules` layout, or that ship `.min.js` siblings. Mitigated by the
   per-package `file:` + build fallback in §3.1.
4. **Two auth schemes coexist.** NAP sessions are new; parts of the gateway REST surface still
   expect per-request NIP-98 signing. Any customer-wallet endpoint that wants NIP-98 needs the
   signer wired in as well as the NAP session.

## 10. Verification status

What has actually been run, as of the end of the first session. Nothing below is
inferred — each line was executed.

**Verified:**

- Backend: 10 containers healthy under project `imani-test`. `account-app` `/actuator/health` UP;
  `POST /api/v1/auth/init` returns a real NAP validation error, so the endpoint and path are right.
  `customer-wallet` UP. Mint `/v1/info` responding. Relay serving NIP-11 on `0.0.0.0:7777`.
- Package aliasing: 14/14 entry points import from source under Vitest.
- Farmer grouping: 4/4, including a regression guard for the epoch-vs-ISO expiry mismatch.
- `tsc -b --force` exits 0. `vite build` succeeds.
- Dev server serves the app, `/api` proxies to NAP, `/customer` proxies to customer-wallet, and the
  `nut18v.js` shim is served with its `window.NUT18V = NUT18V` assignment intact.

**Verified in a real browser (2026-08-12, session 3 — see §11.6):**

- **Receiving a coupon**, end to end: unlock → NAP login → DM poll → NIP-17 unwrap → redemption →
  `POST /api/v1/wallet/receive` **200** → escrow acknowledged → voucher + transaction rows in
  IndexedDB → **coupon rendered on the Farmers screen**. Repeated across several coupons; a coupon
  redeemed while a screen is open re-renders it without a reload.
- **Paying a farmer**, end to end. `/pay` drives imani-apps' own `POST /api/v1/atomic-send` saga to
  COMPLETED; two real payments delivered NIP-17 gift wraps, confirmed **on the relay by matching
  event id** (`17788ff3fea623ea`, `bad56893e9203fcc`) rather than from the success screen. Wallet
  settled 9 coupons €45.00 → 8 coupons €40.00. Needed one config change, not backend work — see
  §11.6 on FR-GAP-009.
- **Every screen against real data**: farmer list with a wallet-wide total; farmer detail capped at
  3 per list with `See all`; both full lists; coupon and transaction detail, including a deep-linked
  URL and a transaction id containing a colon surviving encode/decode; `/receive`'s npub QR matching
  the seeded identity; `/scan`'s clipboard fallback (headless has no camera).
- **The sats backing is really sats** — checked against the token's own proof sum via
  `sumTokenProofs`, not against `face_value`, because this stack issues at ratio 1.0 where the two
  are the same number (§11.7).
- 61 vitest tests, `tsc -b --force` clean.

- **A partial payment**, splitting a coupon and returning change — §11.8. €2.50 against a €5.00
  coupon: `is_full_send=false`, wallet €40.00 → €37.50 with the coupon count unchanged, and the
  change coupon reading face 250 / 250 sats, its sats confirmed against the change token's own proof
  sum.

**Known gaps, deliberately left visible rather than faked:**

- `nostrAdapter.publishProofs` throws instead of returning success. NIP-60 proof backup is disabled
  in the sender config; a silent no-op here would be a lie about where proofs live.
- The relay URL in `pay.ts` is hardcoded to the local stack. In the vanilla app this comes from
  `/api/v1/config` via `GatewayConfig`. Marked with a `ponytail:` comment.
- `totalFaceValue` sums naively across currency units.
- Three tsconfig strictness flags (`verbatimModuleSyntax`, `noUnusedLocals`, `erasableSyntaxOnly`)
  are off, because source-aliasing makes tsc apply this app's flags to nine upstream packages that
  compile clean under their own. `strict` stays on.

## 11. Seeding — how coupons get issued

`scripts/seed-farmer.mjs`. Farmer keypairs persist in `.seed-keys.json` so repeat runs issue from the
same identity instead of littering the farmer list with duplicates of one person.

**Issuance is a merchant-tier operation.** `POST /api/v1/wallet/vouchers` on customer-wallet refuses
it outright, and the refusal is the architecture speaking:

> "Voucher creation is not supported on JdbcWalletPort — the customer-wallet is self-custodial
> (Constitution Principle II). Voucher state is client-held; the backend MUST NOT persist vouchers,
> proofs, or balances. If a caller is hitting this guard, its request is routing to the wrong tier."

The correct endpoint is gateway-portal's `POST /api/v1/portal/vouchers`. The issuer is never a
request field — it is whoever the portal authenticated, so the farmer's identity is their key.

Four further stack defects had to be cleared to make one coupon exist:

5. **The portal ignores `X-Auth-Pubkey` unless an edge secret is set.** `NapProxyAuthFilter` fails
   closed by design (CRIT-4) when `GATEWAY_PORTAL_EDGE_SHARED_SECRET` is unconfigured, which the
   test compose leaves blank — so every portal call returns "NIP-98 authentication required"
   regardless of what you send. Set in the override; the seed script stands in for edge-proxy.
6. **Test fixtures make issuance impossible.** `TestFixturesWalletPort` extends `JdbcWalletPort`
   via the 4-arg `super(walletService, mintApi, tokenCodec, defaultMintUrl)` — the constructor
   *without* `Optional<VoucherAdapter>`. Its adapter is therefore always empty and `createVoucher`
   always trips the self-custody guard, no matter what `GATEWAY_CUSTOMER_WALLET_STATE_ENABLED` says.
   The test compose enables fixtures, so issuance can never work there. Turned off; the log then
   reads `customer_wallet_port_created type=JdbcWalletPort voucher_adapter_wired=true`.
7. **`phoenixd-mock` is required, not optional.** The mint backs every voucher with a Lightning
   invoice (`POST /createinvoice`), so `/v1/mint/quote/voucher/bolt11` 500s without it. It was one
   of the three 404 image names, and skipping it silently blocks all issuance.

**Result:** 3 × EUR 5.00 coupons, status `ISSUED`, from farmer pubkey `7952939535a79edc…`.

### 11.1 The voucher issuance lifecycle (investigated 2026-08-11)

An earlier draft of this spec claimed `expires_at` was broken. **It is not.** Both alarms were
artifacts of reading a voucher mid-flight. What actually happens:

1. **The farmer must hold sats.** PROPORTIONAL backing needs 500 sat to back €5.00, and a new
   farmer has 0. The log is explicit: `Insufficient balance for voucher issuance. Required: 500 sat
   (backing for face value 500 EUR), Available: 0 sat`.
2. **Insufficient balance is not an error.** `VoucherAdapter` takes an
   `insufficient_balance_fallback` path and returns a PENDING voucher carrying a bolt11
   `payment_request` and a `quote_id` — a top-up invoice.
3. **On a PENDING voucher, `expires_at` is the Lightning mint-quote deadline — 60 seconds.** It is
   not voucher validity. Reading it at this moment is what produced the "born expired" claim.
4. **phoenixd-mock auto-settles** (`autopay_enabled=true`, 2s delay). The quote flips to PAID and
   the voucher becomes `status=ISSUED`, `payment_state=CONFIRMED`, carrying a real Cashu token.
5. **`expires_at` is then populated asynchronously**, roughly 5–10 s *after* the voucher already
   reports ISSUED/CONFIRMED. During that window the field is JSON `null`. Reading it there is what
   produced the "no expiry" claim.

Confirmed by polling one voucher across its lifecycle, and by re-reading every voucher that had
shown `null`: **all of them settle to exactly `issued_at` + 90 days.** `expiry_days` propagates
correctly through the portal. There is no backend expiry bug.

**This did surface a real client-side bug, now fixed.** `toVoucher` guarded expiry with
`row.expires_at === undefined`. The gateway sends `null` during the async window, `null === undefined`
is false, so the guard fell through to `new Date(0)` → 1970 → `VoucherGrouper` filters the coupon as
expired → the farmer silently vanishes from the list. A coupon received seconds after issuance would
hit this every time. The guard is now truthiness-based, covering `null`, `undefined` and `0`, with a
parameterised regression test for all three plus a counter-test that a genuinely expired coupon is
still excluded.

**One open item:** `GET /api/v1/portal/vouchers` returned an empty list shortly after a successful
create, so merchant-side ledger state is still unconfirmed. Given the async-population behaviour
above, this is plausibly the same lag and worth re-checking before treating it as a defect.

### 11.2 Delivery over NIP-17 (verified 2026-08-11)

`scripts/seed-farmer.mjs` now runs the whole chain: issue → wait for Lightning settlement → deliver
→ verify. One command, and it checks its own work.

**The gateway does the gift-wrapping, not the script.** `DmSender` delegates to
`apiAdapter.sendTokenDm`, i.e. `POST /api/v1/dm/tokens/send`, where `TokenDmTransferAdapter` builds
the kind-1059 wrap in exactly the shape the receive pipeline parses. Hand-rolling NIP-59 in the seed
script would only risk drifting from that format. The DM is signed by the gateway's identity rather
than the farmer's, which is fine: farmer attribution rides on `issuer_id` inside the payload — also
what the wallet groups by — not on who signed the envelope.

Two things the endpoint needs that issuance did not: **NIP-98 auth** (voucher creation accepts
`clientId=unknown`; this does not), and **readiness**. A voucher is not deliverable when created —
it is PENDING with a top-up invoice and carries no token until phoenixd-mock settles it. Poll on
`token` presence; `expires_at` is not a readiness signal (§11.1).

**Verified end-to-end:** 4 kind-1059 gift wraps on the relay addressed to the demo customer,
decrypting with the customer's key to kind-14 rumors, each containing a real `cashuBv2…` token and
`issuer_id` matching the farmer exactly.

**The wire payload is snake_case.** Decrypted content is
`{type: 'cashu_token_transfer', version, token, memo, amount_hint, unit, voucher_id, face_value,
face_unit, face_decimals, token_amount, backing_strategy, issuer_id, sender_pubkey, created_at,
expired}`. This is **not** `PayloadBuilder.DmPayload`, the sender-side type, which is camelCase
(`faceValue`, `issuerId`). Reading a received DM with the sender's type silently yields undefined
for every field that matters, including the issuer the farmer list groups by. `src/lib/receive.ts`
maps the real shape onto `VoucherRow`, with `token_id = sha256(token)[0:32]` so a redelivered coupon
collapses onto one row instead of duplicating. Tested against a payload captured from a live
delivery.

Note `expired` is a boolean, not a timestamp, so `expires_at` is left undefined rather than
fabricated — consistent with the null-expiry lesson in §11.1.

**Two self-inflicted detours worth recording:**

- Node 20 has no global `WebSocket`. Without the `ws` polyfill, `SimplePool` fails inside a promise
  that `publish()` reports as *fulfilled*, so every relay query silently returns 0 — delivery looks
  broken when it is working. The polyfill in `countGiftWraps` is load-bearing.
- On the strength of that false signal, NIP-42 was briefly disabled in `deploy/strfry.conf`. It was
  never the cause: reads of kind-1059 wraps succeed with auth enabled. Auth is back on and the
  config records why.

### 11.3 In-app receive — imani-apps' pipeline (2026-08-11)

`src/lib/dmPoll.ts` runs `@imani/dm-poll`'s `DmPollService` — the same coordinator the vanilla app
drives, not a reimplementation. It starts once the wallet is open and stops on unmount.

Reads go through **the gateway's nostrdb, never the relay** — the package's stated contract, and
what buys server-side chunk reassembly. Writes still go browser → relay.

Adapters supplied by this app:

- **`NostrdbAdapter`** — `POST /customer/api/v1/nostr/query` and the SSE subscription.
- **`CryptoAdapter`** (`src/lib/dmCrypto.ts`) — `nip17.unwrapEvent` with the unlocked key, plus
  payload parsing.
- **`StorageAdapter`** — writes into the same `WalletStorage` the UI reads, so an arriving coupon
  reaches the farmer list through the existing broadcast with no extra plumbing.

**Two deviations from imani-apps' adapter, both forced and both narrow:**

1. **JSON envelope first.** dm-poll's `TokenParser` only regex-parses the legacy human-readable form
   (`🎁 Token Transfer: 1.00 USD`); the gateway emits JSON `cashu_token_transfer`. Our
   `parseTokenTransferMessage` handles JSON and falls through to the package's parser for text, so
   legacy senders keep working — covered by a test.
2. **Content-derived fingerprint** — `sha256(token)[0:32]`, matching wallet-storage's `token_id`
   rule (spec 017), so a redelivered coupon collapses onto one row.

**The filter trap.** The gateway's query DTO reads **`pTags`** and **silently ignores `#p`** —
verified: filtering `#p` on an all-zero pubkey returns the full unfiltered set, while `pTags`
correctly returns only the customer's. Sending the Nostr-standard `#p` would feed the wallet every
gift wrap on the box, none of it decryptable, and the failure would present as flaky delivery rather
than a filter that never applied. `EventFilter` already names the field `pTags`, so it passes
through — but the trap is one keystroke away.

`src/lib/receive.ts` was deleted. Its parsing was a second implementation of what the CryptoAdapter
slot is for; the logic and its tests moved to `dmCrypto.ts`.

### 11.4 Browser verification (2026-08-12)

Driven in a real browser via Playwright. **Verified working end to end:**

1. Enrol an nsec + passphrase → nap's WebCrypto keystore persists it (reload returns "Unlock", no
   nsec field, so `hasKey()` reads the stored record).
2. Passphrase unlock → key decrypted → `EvictableSigner` built → **real NAP login succeeds**.
3. Wallet IndexedDB opens, the Farmers screen renders with Pay / Receive, zero console errors.
4. `DmPollService` starts, fetches from the gateway's nostrdb, and **unwraps the NIP-17 gift wrap**:
   `[dmCrypto] unwrapped ok, content bytes: 11004` — the same length the Node-side decrypt produced.

**Three defects found and fixed by doing this:**

- **`baseUrl` was `/api`, must be `/api/v1`.** nap builds `${baseUrl}/auth/${path}`; the gateway
  serves `/api/v1/auth/init`. The wrong URL returns **401, not 404**, so the mistake presents as an
  auth failure and sends you hunting the wrong problem.
- **The poller was being killed by its own cleanup.** `stopDmPoll()` in the effect teardown races the
  async `openWallet()` under StrictMode's mount/unmount/remount: cleanup fires while the promise is
  pending, then the resolved promise starts a poller nothing will stop. Observed exactly as
  "Fetched 1 gift wrap events" immediately followed by "Stopping...", coupon dropped mid-flight. The
  poller's lifetime is the session, not the component.
- **The 24h `recentDmsSince` default is too narrow.** NIP-59 randomises a gift wrap's `created_at`
  into the past, so a coupon sent minutes ago can carry a two-day-old timestamp and fall outside the
  window — on the relay, invisible to the wallet. Widened to 7 days.

**Blocked on one thing: redemption.** No coupon reaches the screen yet, and the reason is structural,
not a bug in the wiring:

```js
if (this.config.enableAutoRedemption && this.config.redemptionAdapter) {
  await this.redeemToken(tokenDm);      // ← the ONLY caller of storageAdapter.saveVoucher
}
await this.eventTracker.add(event.id);  // ← marked processed either way
```

`saveVoucher` is reachable only through the redemption path. With no `RedemptionAdapter` the token is
unwrapped, extracted, **silently dropped, and permanently marked processed** — a later wiring of
redemption will not reprocess it. Recovery is clearing `imani-wallet:dm-poll:processed` from
localStorage, which is what the browser runs above did.

`RedemptionAdapter.redeem(token) → Voucher` means swapping the token at the mint so the customer owns
fresh proofs and the farmer cannot double-spend. Two candidate implementations, and this needs a
decision rather than a guess:

- **`shared/tokenRedemption.js`** — imani-apps' canonical path, named a crown jewel in their
  migration doc ("extract whole, never rewrite"). 2,115 lines, unextracted, with a wide transitive
  dependency on other `shared/*` globals.
- **A client-side swap via `@cashu/cashu-ts`** — what the offline-wallet package does. A new
  dependency and real money logic.

Explicitly NOT an option: `POST /api/v1/dm/tokens/{eventId}/claim` is `@Deprecated` with "New code
must NOT introduce callers", pointing at `TokenRedemption.redeem` as canonical (spec-038 FR-009).

### 11.5 Bridging tokenRedemption.js (2026-08-12) — partial, one design change needed

`src/lib/legacyBridge.ts` + `redemptionAdapter()` in `dmPoll.ts`. Redemption now **runs** against
imani-apps' canonical coordinator. Verified in-browser, in order:

```
[tokenRedemption] Starting redemption, token length: 10514 source: dm-poll
[TokenSecurity]   cashuB token detected, skipping decode validation
[tokenRedemption] Token size valid: 10514 bytes
[currency]        step=dm face_unit=EUR
[tokenRedemption] buildVoucher face_unit resolved {unit: EUR, source: dm}
```

That `step=dm` line is the five-source face-unit fallback doing its job — the exact scar tissue a
reimplementation would have lacked, earning the bridge decision on its first run.

**Now loaded as classic scripts — this works.** `[format] format.js loaded v3`, `resolveDecimals`
resolves, and redemption runs to the mint call with an idempotency key.

**The design change.** These `shared/*.js` files are **classic scripts**, and importing
them as ESM was the wrong mechanism. Under ESM a top-level `const api = …` or
`function resolveDecimals(…)` becomes *module-scoped*, so dependents evaluating a bare `api` /
`resolveDecimals` see nothing. Some files paper over this by self-assigning `window.X`
(`nostr.js`, `api.js`, `tokenRedemption.js`, `tokenSecurityIntegration.js`) — those work on a
side-effect import. Others do not:

| Module | Self-assigns? | Under ESM |
| --- | --- | --- |
| `nostr.js`, `api.js`, `tokenRedemption.js`, `tokenSecurityIntegration.js` | yes | works |
| `gateway-config.js` | no | needs manual publish |
| `currency.js` | n/a — real ES module | import normally |
| **`format.js`** | **no export, no window assignment** | **unreachable** |

`format.js` is what broke the ESM approach: with neither an export nor a window assignment, there is
nothing an import can retrieve. `legacyBridge.ts` now loads all six via injected `<script>` tags
(`?url` imports, so Vite resolves them in dev and emits them on build). Every top-level `function`
lands on globalThis and every top-level `const` in the global lexical environment — both resolvable
as bare identifiers from later scripts and from module code — so the files satisfy each other exactly
as in the vanilla app. `currency.js` stays an ESM import, being the one real module.

**Where it stopped:** `api.receive` returned **400**, which tokenRedemption mapped to
"Token already redeemed (idempotent)". Resolved in §11.6 — the mapping was hiding two different
real causes, and reading the response body was the whole job.

**Credentials: two separate stores, and setting one is a silent half-fix.**
`NostrUtils.setAuthCredentials(privkey, pubkey)` covers NIP-42 relay AUTH;
`api.setNostrCredentials(pubkey, privkey)` — note the reversed argument order — sets the NIP-98 HTTP
signing keys the gateway client reads as `_nostrPublicKey`/`_nostrPrivateKey`. Wiring only the first
logs a cheerful "Auth credentials set for NIP-42" while every authenticated call still fails with
"NIP-98 authentication required but Nostr credentials not set". Both are now wired; the NIP-98 half
has not yet been re-verified in-browser.

**Two traps already paid for, worth keeping:**

- **A wrong shim is worse than no shim.** `tokenRedemption.js` installs its own correct
  `window.ImaniCurrency` mirror, but only `if (!window.ImaniCurrency)`. A guessed shim
  (`normalizeUnit`/`isZeroDecimal`) did not sit alongside it — it *suppressed* it, surfacing as
  `__currencyApi.normalizeFaceUnit is not a function` deep inside `_doRedeem`. Provide the true
  contract or provide nothing.
- **`Storage` must be assigned.** The DOM already defines a global `Storage` constructor, so
  `typeof Storage !== 'undefined'` passes on its own and `Storage.getItem(...)` then throws. The
  failure lands at the call site, not the guard.

**Also still needed for a real receive:** `NostrUtils.setAuthCredentials(privkeyHex, pubkeyHex)`.
Currently unset, so `api.inspectVoucher` warns "NIP-98 authentication required but Nostr credentials
not set" and takes the fallback chain. `api.receive` — the actual mint swap — is authenticated and
will fail hard without it. The wallet holds both values (`getSigner()`), so this is a one-line wire
once the script-loading change lands.

Minor: `lib/token-security.browser.js` is absent, so fingerprints degrade to a warned
`fallback_…` value. Internally consistent, but weaker as an idempotency seed.

> **This "minor" was the hard blocker.** See §11.6 — it is not weaker, it collides, and it silently
> discards every coupon after the first. Filed as cosmetic because the fallback *looked* consistent.

**Also open:** nostrdb held 1 gift wrap for the customer where the relay held 4. The gateway's
`RelayIngestPump` subscribes for its *own* pubkey, so nostrdb may only contain wraps the gateway
itself sent — third-party sends might never reach a nostrdb-only reader. Since dm-poll reads
exclusively through nostrdb, this caps what the wallet can ever see and matters for a farmer sending
direct.

### 11.6 Receive completed, and the pay-path wall (2026-08-12)

**A coupon now reaches the screen.** The 400 was hiding two different causes in sequence, and every
step below was read off a response body, a container log, or IndexedDB — never inferred.

**1. The 400 was already a 401 by the time it was re-tested.** The `setLegacyCredentials` fix from
the previous session had landed but was never re-run. NIP-98 was being sent; the gateway rejected it
with `{"code":"AUTH_002","message":"URL mismatch"}`. `shared/api.js` signs the `u` tag with the
browser origin, and `changeOrigin: true` on Vite's `/api` proxy rewrote `Host` to `localhost:28082`,
so the gateway reconstructed a different URL. **`changeOrigin` must stay `false`** for the
customer-wallet proxy — it is now commented in `vite.config.ts`. This is the second time a proxy
detail has presented as an auth failure (§11.4's `baseUrl`).

**2. Then a genuine 400: `verify_proof_already_used_error`.** Not a bug — a *stale browser page from
an earlier session* was still polling and redeeming coupons seconds after each seed. Two Vite servers
were running; receive calls appeared in the log that no live tab had made. If coupons vanish between
seeding and testing, look for another client before touching code. Working on a port no stale tab
knows about is the cheap defence.

**3. `saveVoucher is not defined`** — swap succeeded, local write threw, coupon existed only as a
backend escrow. `_persistRedeemed` prefers `walletStorageIntegration.atomicallyWrite` and falls back
to shared/storage.js's bare `saveVoucher`, which we do not load. Fixed by loading
`shared/walletStorageIntegration.js` as a seventh classic script and `init`-ing it with **the same
WalletStorage instance the UI reads**. That takes the atomic voucher+transaction path, which is the
better one anyway.

**4. camelCase/snake_case, again (§11.2's trap, one layer on).** dm-poll's `TokenMetadata` is
camelCase; tokenRedemption reads `metadata.issuer_id`, `.face_value`, `.face_unit`, `.face_decimals`,
`.token_amount`, `.backing_strategy`, `.memo`, `.sender_pubkey`. All undefined, nothing thrown: the
coupon persisted with `issuer_id: null`, and since the farmer list groups by issuer it rendered as
nothing. `toLegacyMetadata` in `dmCrypto.ts` bridges both spellings, with a regression test.

**5. The fingerprint collision — the real blocker.** Without `lib/token-security.browser.js`,
`tokenSecurityIntegration` falls back to `fallback_${token.slice(0,50)}_${token.length}`. Every
voucher this stack issues shares a CBOR header and a length, so **all of them collapse onto one
fingerprint**. Observed in localStorage as a single claim key:

```
imani_redeem_claim:fallback_cashuBv2F0gb9haUgA4zcuYdBWBWFwhr9hYRkBAGFzeQToWyJW_10514
```

tokenRedemption keys its cross-tab claim ledger on that value, so coupon #2 onwards short-circuits
as "already DONE" against coupon #1's voucher_id — and it seeded the gateway `Idempotency-Key` too.
Fixed by loading the real `ImaniTokenSecurity` (`var ImaniTokenSecurity = …`, a classic-script
global, which is why an ESM import could never have worked). Fingerprints are now distinct per
token: `5746d76377f957d8…`, `7ae9919ed8e44641…`.

**6. The coupon was in IndexedDB but not on screen.** `WalletStorage.postEvent` publishes to a
BroadcastChannel, and local listeners are fanned out only when that channel *delivers* — and
BroadcastChannel never echoes to the posting context. A coupon redeemed by this tab notified every
tab except the one that needed to re-render. `onWalletChanged` / `notifyWalletChanged` in `wallet.ts`
cover both; screens must subscribe through them, not `getWallet().onChange`.

**7. No transaction rows, ever.** `_buildReceiveTransactionRow` returns null when `voucher.token_id`
is absent, and token_id synthesis lives in shared/storage.js's `saveVoucher` — not loaded. Observed
directly by wrapping `atomicallyWrite`: `token_id: null`, `transactions: []`. The voucher row
survived because WalletStorage auto-derives the id on write, which is exactly what hid this.
`installTokenIdFill` in `legacyBridge.ts` fills the id (via the package's own `tokenIdFrom`) and
rebuilds the row with tokenRedemption's own builder. The farmer screen's Transactions section had
been empty by construction for every coupon ever received.

**8. `transactionsWith` filtered on the wrong field names.** It read `issuer_id`/`created_at`; the
canonical writer emits `merchantId`/`counterparty`/`timestamp`. An empty list is indistinguishable
from "no transactions yet" — the screen said "Nothing yet." over a store that had the row. **Read the
writer, not the type name.**

#### `/receive` — nip05 is not obtainable here

The design said "QR of the customer's nip05". Nothing in this stack can produce one: registration is
bottin's job (out of scope, §2), bottin's `.well-known/nostr.json` is `{"names":{}}`, and no
per-pubkey reverse lookup exists on any tier — the `/api/v1/identity/{pubkey}` the page called was
written from assumption and 404s. It now shows the **npub**, which is the same destination a sender
would resolve the alias to. Deviation from §6, deliberate and marked `ponytail:`.

**Superseded 2026-08-13 (§14).** The premise no longer holds: customers registered in the wallet do
have a nip05, claimed through `POST /api/v1/nip05` and stored on the local profile record. The npub
fallback stays for accounts enrolled from an existing nsec, which still have no handle.

#### `/pay` — rewired onto imani-apps' real send path (2026-08-12)

The split investigation below was answered by reading what imani-apps actually does. **It does not
split to spend.** Its send screen (`voucher/js/send.js`) drives `bundleSendOrchestrator` →
`shared/atomicSendIntegration.js` → `api.initiateAtomicSend` → **`POST /api/v1/atomic-send`**: one
escrowed server-side saga that splits, sends the NIP-17 DM and returns a `keep_token` for the change.
`VoucherSender` is not on that path at all.

Two findings that make the old approach a dead end rather than a bug:

- **`api.splitPreview` is a UI affordance.** In send.js its result is cached in `splitPreviewData`,
  which is **written and cleared but never read**, and its `catch` merely hides a rounding hint. A
  failing preview never blocks a vanilla send. Ours treated it as fatal.
- **The endpoints live on a different tier.** imani-apps' `nginx.conf.template` has
  `location /api/ { set $upstream_api account-app:8081; }` — the vanilla app has always talked to
  account-app. Probed across all three tiers: `/api/v1/atomic-send` **exists on account-app (28081)**
  and 404s on customer-wallet; the split endpoints 404 on account-app, 500 on customer-wallet (the
  self-custody guard) and 403 on portal.

`vite.config.ts` now routes `/api/v1/atomic-send` → 28081, listed **before** `/api` so it wins the
prefix match, `changeOrigin: false` for the same NIP-98 reason as §11.6(1). `pay.ts` calls
`window.api.initiateAtomicSend` — imani-apps' own client, already loaded by legacyBridge — polls
`getAtomicSendStatus` to a terminal state, then saves `keep_token` or removes the fully-spent coupon.

**Verified saga trace** (`send_id=as_3c8bc4a30a164d4f`), read from account-app's log:

```
nip98_auth_success  →  atomic_send_initiated  →  INITIATED → SPLITTING
atomic_send_split_completed is_full_send=true  →  SPLITTING → TOKEN_HELD
atomic_send_dm_delivery_start
atomic_send_dm_delivery_error error_code=DM_PUBLISHER_UNAVAILABLE
TOKEN_HELD → DM_ERROR
```

Auth, initiation, split and escrow all succeed. `is_full_send=true` confirms the exact-value case
needs no split at all.

#### FR-GAP-009 was a config gap, not missing code — `/pay` now completes

Delivery first failed with what reads unmistakably as an upstream blocker:

```
No real DM publisher is wired in the decomposed stack yet.
Nostr publication prerequisite is pending (FR-GAP-009 upstream blocker).
```

**That message is stale, and believing it costs a session.** The real implementation ships in these
very images, on both sides:

- `gateway-core` has `Nip17DmSendPublisher` + `Nip17DmSendConfiguration`, gated behind
  `gateway.atomic-send.delivery.nip17.enabled=true`.
- `customer-wallet` has `WalletInternalController` serving `POST /internal/v1/wallet/dm/tokens/send`
  — live, returning 401 (auth) rather than 404.

The trap is the wiring on `DefaultDmPublisher`:

```java
@ConditionalOnMissingBean(DmPublisher.class)
@ConditionalOnProperty(name = "gateway.atomic-send.delivery.nip17.enabled",
                       havingValue = "false", matchIfMissing = true)
```

`matchIfMissing = true` means an **unset** flag silently selects the stub that fails every send, and
the stub then blames an upstream gap. Boot logs state the truth plainly if read:
`dm_publisher_registered type=DefaultDmPublisher` and
`service_credential_provisioner complete provisioned=0 skipped=3`.

Fixed in `deploy/compose.override.yml` with two settings — the flag on account-app, and one shared
dev secret on both sides (`GATEWAY_ATOMIC_SEND_DELIVERY_NIP17_SERVICE_TOKEN` ↔
`CUSTOMER_WALLET_SVC_CRED_ATOMIC_OPS`, since gateway-core calls customer-wallet with
`X-Service-Id: atomic-ops` / `X-Service-Token` and customer-wallet hashes that credential at boot).
After restart: `dm_publisher_registered type=Nip17DmSendPublisher` and
`service_credential_provisioner provisioned service_id=atomic-ops`.

**Verified end to end** — two real payments, `send_id=as_88e97dbe84f147ad` and one after it:

```
INITIATED → SPLITTING → TOKEN_HELD
nip17_send_attempt  base_url=http://customer-wallet:8082
nip17_send_published event_id=17788ff3fea623ea…
TOKEN_HELD → DM_SENT → COMPLETED → atomic_send_ack_keep_token
```

and the farmer really holds the coupons — queried straight off the relay, matching those event ids:

```
gift wraps addressed to FARMER: 2
   bad56893e9203fcc  2026-08-12T10:37:25Z
   17788ff3fea623ea  2026-08-12T10:34:42Z
```

Wallet settles correctly: **9 coupons €45.00 → 8 coupons €40.00** after paying €5.00.

**One "looks like success" bug this exposed, worth its own line:** `WalletStorage.removeVoucher`
takes a **`token_id`**, not a `voucher_id`, and returns `false` for an unknown key instead of
throwing. The first successful payment therefore showed "Paid" while the spent coupon stayed in the
list at full value. `pay.ts` now resolves the row's real key first (`voucherKey`), logs loudly if the
removal matches nothing, and re-derives `token_id` whenever a coupon's token is replaced
(`replaceVoucherToken`) — a content-derived key cannot be carried across a token change.

**Residual state:** two coupons stranded before the fix (`9d0eed3c…` and one other) are still held
server-side in DM_ERROR. Reclaim cannot return them here (`Reclaim requires HTTP receive endpoint
which is not yet available`), and the gateway refuses new sends against them ("An active send already
exists for voucher …"). `payRequest` walks past coupons refused as busy, so they no longer block a
wallet that holds good ones; the idempotency key is keyed by payment **and** coupon so moving to the
next candidate is a genuinely distinct send. Reclaim stays best-effort and never replaces the
original error.

**Still genuinely missing upstream:** the reclaim receive endpoint.
`WalletPortAdapter.receive` throws `UnsupportedOperationException("receive not yet supported via
HTTP")`, and unlike the DM publisher its precondition really is unmet — customer-wallet's
`WalletInternalController` exposes `/swap`, `/mint`, `/melt`, `/dm/tokens/send`,
`/dm/tokens/received` and `/vouchers/{id}/burn-intent`, but no receive. It only matters when a send
fails after TOKEN_HELD, which no longer happens on the happy path.

Filed upstream as **398ja/imani-gateway-core#55** — the stale stub message, the `matchIfMissing`
default, and the reclaim gap, with the saga traces and the two-line compose fix.

#### Superseded: the earlier "tier mismatch" analysis

Kept for the diagnosis, which stands even though the conclusion did not. When `/pay` was still built
on `VoucherSender`, Confirm failed at `POST /api/v1/wallet/vouchers/split/preview` with a bare
**500 `INTERNAL_001`** whose cause was only in the container log:

```
UnsupportedOperationException: Voucher split preview is not supported on JdbcWalletPort —
the customer-wallet is self-custodial (Constitution Principle II). Voucher state is client-held;
the backend MUST NOT persist vouchers, proofs, or balances.
```

Same guard family that refuses issuance (§11). Both `/split/preview` and `/split` refuse **any**
input — verified independently of our request shape. And `VoucherSender.send()` calls `executeSplit`
unconditionally, even when the held coupon matches the requested amount exactly (we hold 4 × €5.00
and the request was €5.00), so there is no no-split path to fall back to.

So the pay path as originally written pointed at a tier that will not serve it. That framing assumed
the split endpoints were the way to spend; they are not, and the section above supersedes this. The
resolution was not to pick one of the three options once considered here (client-side cashu swap —
forbidden by SR-10; route the split to another tier; a new stateless split endpoint) but to use the
send primitive imani-apps itself uses, which never touches those endpoints.

One real client bug was fixed on the way: `/api/v1/dm/tokens/send` takes **`recipientPubkey`**, not
`recipient` (confirmed from the endpoint's own `field_errors`; `seed-farmer.mjs` had it right all
along).

### 11.6b The send path addresses coupons by `token_id` (2026-08-13)

A code review found `pay.ts` resolving the spent row with
`getVoucherByVoucherId` — an **index-only** lookup — while `toVoucher` hands callers
`voucher_id: row.voucher_id ?? row.token_id`. For a row stored without a voucher_id that lookup was
therefore given a token_id, matched nothing, and returned null. In one call: `removeVoucher` no-opped,
so the just-spent coupon stayed in the wallet **at full face value**, and `{...row}` spread nothing,
so the change coupon lost its issuer, unit, decimals and ratio and grouped under the synthetic
`unknown` farmer. Even a hit was unsafe — `couponsFor`'s doc in `farmers.ts` already says voucher_id
is a merchant TEMPLATE id shared between coupons, so it cannot address one.

The fix is to stop looking the row up at all. `payRequest` keeps the selected `VoucherRow` beside its
`Voucher` (a `Map` keyed by object identity — `selectVouchers` filters and sorts, never clones) and
every local write uses `row.token_id`, the store's content-derived primary key. `voucherKey` is gone,
and `replaceVoucherToken` no longer overrides `voucher_id`: the spread carries the row's real one.

Two more from the same review:

- Candidate selection now calls **`couponsFor`** instead of `v.issuer_id === farmer.pubkey`, which
  compared a raw issuer id against a VoucherGrouper-normalised pubkey. Any row whose issuer_id
  differed in case was invisible to `/pay` while its coupon sat on the farmer's card. Pay and the
  farmer screens now share one definition of a farmer's coupons.
- **Running out of polls is not a failed payment.** The 20s budget expiring left a non-terminal
  status, which fell into the failure branch and told the customer "Payment did not complete" while
  the farmer went on to receive the coupon; `reclaim` could not soften it because a non-terminal
  status is not `RECLAIMABLE`. That case is now its own message, says explicitly that it has *not*
  failed, and leaves the local coupon untouched. There is still no reconciliation on the next load —
  a pending-send ledger is the real fix and is marked `ponytail:` in the code.

**Verified end to end**, not just by unit test: a real `NUT18V.generate` request for €5.00 against a
€15.00 coupon. The spent row `a2af1698` was removed, the change re-keyed to `864f72aa` at €10.00 /
1000 sats with `voucher_id`, issuer and unit intact, and the payment transaction keyed by the real
spent `token_id`. This also settles the open question from the 0.10.0 work: `GATEWAY_DEV_MODE=false`
does **not** break `/pay`.

### 11.7 Records, balances and the sats backing (2026-08-12)

Once money moved in both directions, the screens were the weak part: every coupon and transaction
rendered as an inert two-string row, uncapped, with no way to inspect one.

**Drill-down.** Coupon and transaction detail became their own routes (§6). Two things forced the
shape:

- **Coupons must be addressed by `token_id`, not `voucher_id`.** `toVoucher` maps
  `voucher_id: row.voucher_id ?? row.token_id` and drops `token_id` — but `voucher_id` is a merchant
  *template* id, shared between coupons issued together, so it can key neither a React list nor a
  route. `couponsFor` therefore returns stored rows, not `farmer.groups[].vouchers`, and a test pins
  its length to `findFarmer(...).voucherCount` so the list cannot drift from the count on the card.
- **Transaction rows are camelCase and untyped.** `_buildReceiveTransactionRow` writes `merchantId`,
  `tokenId`, `voucherId`, `unit`, `decimals` — none of them `TransactionRow`'s declared snake_case
  fields, so all of it arrives through the index signature and every read needs a cast. That cast was
  already duplicated in two files (and is what made `transactionsWith` filter on `issuer_id` and
  match nothing, §11.6). One `toTransaction` view-model now owns it, and owns two traps with it: the
  writer hardcodes `direction: 'in'` **on payments too**, so direction must be derived from `type`;
  and `timestamp` is documented as seconds while the writer uses `Date.now()`, so it is normalised by
  magnitude.

**Payments now write their own transaction row** (`buildPaymentTransaction`), in the same camelCase
shape the receive path writes — a second spelling would mean one reader with two shapes and one of
them silently returning undefined. Written *after* the coupon settles and non-fatal: the coupon is
the money, the row is a record of it, and a missing history entry beats a phantom coupon.

**Wallet-wide balance** is computed per currency. `totalFaceValue` already carried a note that
cross-unit summing is meaningless; summing across farmers compounds it, so `walletTotals` returns one
entry per unit and the home screen leads with the largest.

#### The sats backing, and the coincidence that hides mistakes

A coupon carries a face value (€5.00) and the sats backing it under a strategy. The backing was on
the row all along as `token_amount`, rendering as a bare unitless `Token amount 500` inside the
collapsed Details block. It is now `Backing 500 sats`, beside `Backing strategy` and
`Issuance ratio`. Following imani-apps: `token_amount` is the field every one of its display sites
reads, and it never decodes proofs at render time (`proof_sum` is client-mint-only and goes stale
after a split; `amount` is a mint-unit storage field).

**We deliberately do not copy imani-apps' Bitcoin feature gate.** Its backing line is wrapped in
`isBitcoinEnabled()`, which reads `GatewayConfig.bitcoinFeaturesEnabled` from `/api/v1/config` — an
endpoint that 404s here, so the gate fails closed and hides the number on every coupon. imani-apps
has a user report of exactly that shape ("the new voucher does not show the sats backing amount and
strategy"), caused by `backing_strategy` defaulting to `LEGACY`, which its detail screen treats as
"hide". We show it unconditionally.

**`issuance_ratio` was being dropped on receive.** It is on dm-poll's `Voucher` and tokenRedemption
resolves it, but our writer copied a fixed field list. It is part of `VoucherGrouper`'s group key and
the grouper reads `voucher.issuance_ratio || 1`, so **every coupon was grouped at ratio 1** — coupons
backed at genuinely different ratios merged into one group, and the screens format a farmer's total
from `groups[0]`. Now persisted, with `issuanceRatioOf` deriving `face_value / token_amount` as the
fallback (imani-apps' `calculateIssuanceRatio`, and what its group builder back-computes).

> **The trap to remember: on this stack face minor units and sats are the same number.** Every coupon
> is issued at ratio 1.0 — `face_value` 500, `token_amount` 500 — so rendering the wrong field looks
> perfectly correct, and so does grouping everything at ratio 1. Verification has to defeat the
> coincidence rather than eyeball a matching number. Two ways used here: the displayed figure was
> checked against the token's own decoded proof sum (`sumTokenProofs` → 500, a global once
> legacyBridge has loaded `shared/format.js`), and the unit tests use a 5000 XAF / 200 sats fixture
> where the two differ.

Reading the live store also corrected an assumption: rows written before a field existed do **not**
lack the key — WalletStorage normalises absent optionals to an explicit `null`. `??` handles it, but
guards written for `undefined` alone would not, so the tests pin the shape that actually occurs.

### 11.8 Partial payments — and the overpayment they exposed (2026-08-12)

Paying less than a whole coupon needed no new mechanism: the atomic-send saga already splits and
returns a `keep_token`. It needed two fixes, the first of which was silently taking the customer's
money.

**The send amount was the coupon's, not the request's.** `pay.ts` passed
`faceValue: candidate.face_value`. gateway-core splits for
`send.faceValue() != null ? send.faceValue() : send.amount()` (`AtomicSendService`), so `faceValue`
IS the amount to send — passing the source coupon's value told it to send the whole coupon. A €2.50
request against a €5.00 coupon completed as **`is_full_send=true`**: the farmer received the entire
coupon, the customer got no change, the wallet went €45.00 → €40.00 for a €2.50 purchase, and the
transaction row recorded €2.50 while €5.00 had left. imani-apps passes `amount` and `faceValue` as
the *same* send amount (`voucher/js/send.js:3380-3383`); only `faceUnit`/`faceDecimals` describe the
source.

> **Every earlier payment hid this.** They were all exact-value, where `request.amount` and
> `candidate.face_value` are the same number, so the correct and incorrect fields were
> indistinguishable — the same shape as the ratio-1.0 coincidence in §11.7. The bug was only
> reachable by asking for an amount smaller than a coupon. `buildSendParams` is now extracted purely
> so a test can assert the invariant without a gateway, and that test states explicitly that the
> exact-value case proves nothing.

**The change coupon has to carry its sats.** `replaceVoucherToken` updated `face_value` and left
`token_amount` at the old figure, so a €2.50 change coupon would have claimed 500 sats of backing.
That is not cosmetic: face value is re-derivable as `round(token_amount × issuance_ratio)`, so a
stale sats figure re-inflates the face on the next read — imani-apps' "25 XAF credited as 5000" bug.
The keep side now takes `keep_face_value` from the status response (the split can round, so a local
subtraction is not guaranteed to match the token issued) and re-derives sats from the change token's
own proofs via `sumTokenProofs`, falling back to the pro-rata `round(token_amount × keepFace / face)`
that the vanilla send screen writes back.

Verified: `atomic_send_split_completed is_full_send=false`, wallet €40.00 → €37.50 with the coupon
count unchanged, change row `face_value: 250, token_amount: 250, amount: 250` and
`sumTokenProofs(token) === 250`, payment transaction recorded at 250 EUR.

#### The minimum split step

A cashu proof cannot divide below one sat, and one sat is worth `issuance_ratio` face minor units, so
the smallest amount that can be split off a coupon is **`ceil(ratio)`**. imani-apps computes the same
floor to step its amount input (`voucher/js/send.js:2319-2325`); here the amount arrives fixed in a
payment request, so it is a validation instead. `checkSplittable` in `pay.ts` enforces:

- a **full send is always allowed** — no split occurs, which is the only way a 1-sat coupon can ever
  be spent;
- the send side must clear the floor (`amount >= ceil(ratio)`);
- **so must the change** (`face - amount >= ceil(ratio)`) — a split cannot leave behind a remainder
  too small to issue, which imani-apps gets implicitly by capping its input at `floor(max / step)`;
- a coupon with `token_amount <= 1` cannot be divided at all, and one with no backing cannot be split
  (`canSplitVoucher`'s rule, `shared/storage.js:4636`).

`selectVouchers` filters on the same check, so the Pay button and the send agree on what is payable
rather than letting a user tap and then be refused; `splitObstacle` gives the confirmation screen the
specific reason ("the smallest amount this coupon can be split into is 25") instead of a generic
refusal.

**At ratio 1.0 the floor is one cent, so none of this bites on the current stack** — which is exactly
why the tests use a 5000 XAF / 200 sats fixture where the floor is 25 XAF, and why one of them
asserts that a €0.01 payment stays *allowed*: the risk with a guard like this is over-tightening and
silently refusing legitimate payments. Verified live at the boundary: a €0.01 payment split a €2.50
coupon to €2.49, with `token_amount` and the change token's proof sum both following to 249.

### 11.9 A lock now actually evicts the key (2026-08-13)

`signer.ts` states the contract: "Between lock and reunlock there is no key in memory to steal"
(RFC §28.6). That was not true. `startDmPoll` handed `DmPollService` the key as
`recipientPrivkey: getSigner().privkeyHex()`, and the service keeps it as a plain **string** on its
config, read on every unwrap. Strings are immutable, so `clearKey()` — which zeroes the signer's own
`Uint8Array` and drops its reference — could not reach that copy. A full plaintext key therefore
survived every lock, inside a service that kept polling and kept decrypting.

The fix is to hand it no key at all: `recipientPrivkey: ''`, and `createDmCryptoAdapter`'s
`unwrapNip17Dm` **ignores the key argument** and reads `getSigner().privkeyHex()` per unwrap. The
signer becomes the only holder, so eviction evicts. `getStatus().hasPrivkey` now reports false, which
is the truth. `refreshDmPollKeys` is deleted — with no stored key there is nothing to re-supply, and
the first unwrap after a reunlock simply reads the restored one.

**Two things the review that found this got wrong, checked against the source and recorded so the
next reader does not inherit them:**

- *"The poller keeps a zeroed key and fails to decrypt."* It does not — it keeps a working copy, which
  is the actual problem. The bug is a lock that fails to lock, not a decrypt that fails.
- *"dm-poll marks the event processed, so the coupon is permanently lost."* It does not.
  `eventTracker.add` runs only on the success paths; a failed unwrap goes to `failedTracker`, and
  `FailedEventTracker.canRetry` is a plain time cooldown with no attempt cap, so the event is retried.
  A locked wallet delays coupons, it does not lose them. `unwrapNip17Dm` still throws rather than
  returning null while locked, so the recorded reason is the real one instead of "failed to unwrap".

**Identity, defensively.** `openWallet` and `startDmPoll` both began `if (x) return x`, ignoring the
userId/pubkey argument, so an in-session account switch would have given the second user the first
user's IndexedDB handle and their running poller. Both now compare the identity and re-open or restart,
`openWallet` closes the previous DB (it holds an IndexedDB connection and a BroadcastChannel that
would keep fanning the old user's writes in), and `Gate` renders `<AuthedApp key={pubkey}>` so the
subtree remounts — several screens subscribe with `[]` deps and would otherwise keep the old
subscription.

This one is **not reachable through the current UI**: there is no logout, `createSession` returns the
existing session, and `LoginPage` renders only when there is none. It is a guard for the switch that
`AuthedApp`'s `[pubkey]` dependency and NapProvider's `identityChange` already anticipate. `stopDmPoll`
finally has a caller.

**Reachable as of 2026-08-13 (§14).** Logout exists, in the header's account menu and in Security's
danger zone. `resetSession()` clears the singleton guard named above, and `stopDmPoll` has its
caller. The identity-switch guard described here is now exercised by ordinary use, not only
anticipated.

Verified: three new tests pin that the adapter decrypts with the signer's key while being handed a
different one, throws while locked, and still returns null for a wrap addressed to someone else. On the
live stack, a freshly seeded coupon was received end to end through the new path
(`[dmCrypto] unwrapping b8e0f389 → unwrapped ok`).

### 11.10 One issuer key, and two housekeeping items (2026-08-13)

`VoucherGrouper.getMerchantId` maps a row with no `issuer_id` to the merchant `unknown`, so `toFarmers`
emitted a farmer holding real money — while `couponsFor` matched on `row.issuer_id?.toLowerCase()`,
which is `undefined` for precisely those rows. The farmer list showed a card with a balance and a
count; that farmer's own page then reported **0 coupons** over an empty list, and
`/farmer/unknown/coupons` was permanently empty. Reachable through a legacy human-readable DM, which
`parseTextMessage` gives no issuerId.

`issuerKey()` in `farmers.ts` now derives the id the way the grouper does — a mirror of its private
`normalizeIssuerId` plus `getMerchantId`'s `issuer_id || 'unknown'`, neither of which
`@imani/voucher-send` exports — and `couponsFor` and `findFarmer` both go through it. `findFarmer` was
doing a bare `toLowerCase()`, so an `npub1…` route param or the `unknown` bucket could never match it
either.

The mirror is duplication, and the guard against it drifting is a test that asserts the property
rather than a fixture: for **every** farmer `toFarmers` produces, `couponsFor` must return
`voucherCount` rows. Anything on the farmer list that cannot be opened is money the holder cannot see.

Also: `.seed-keys.json` is now gitignored — `seed-farmer.mjs` writes farmer and customer **secret keys**
there in hex, making it exactly as sensitive as an nsec, and it sat unignored at the repo root (proved
with `git check-ignore` in a throwaway repo, since this directory is not one). And `package.json` gained
`test` / `test:watch`, so the eight suites can be run by anything other than a person typing `npx
vitest` from memory — `npm test` was previously an error.

### 11.11 Local deploy — the build that dev never tested (2026-08-13)

`npm run build && npm run preview` serves the production bundle on **:4173**, against the same docker
stack. Two things had to be fixed first, and both were invisible in dev by construction.

**A blank page from two Reacts.** The built app rendered an empty body and one console line:
`TypeError: Cannot read properties of null (reading 'useState')`. `@imani/nap-react` is aliased to
source in `../nap`, so its `import 'react'` resolves against **that repo's** node_modules — react
19.2.4 there against 19.2.3 here. Two instances means two hook dispatchers, and the one nap-react
calls is null while the other renders. Vite's dep optimizer collapses the duplicate in dev, so this
appears only once the app is built. Fixed with `resolve.dedupe: ['react', 'react-dom']`.

Worth remembering as a class: **every alias into a sibling repo is a chance to import that repo's copy
of a singleton.** React is the one that fails loudly; a second copy of a context or a store would fail
quietly.

**`vite preview` does not inherit `server.proxy`.** Without its own, the preview server answers every
`/api` call with its own index.html, which surfaces as JSON parse errors rather than a routing
problem. The proxy table is now a single `const` shared by `server` and `preview`, so the two cannot
drift — including the `changeOrigin: false` that the NIP-98 `u`-tag check depends on.

The classic imani-apps scripts needed nothing: they are imported `?url`, so the build emits all eight
(`api`, `nostr`, `tokenRedemption`, `walletStorageIntegration`, `format`, `gateway-config`,
`tokenSecurityIntegration`, `token-security.browser`) as assets.

**Verified on the deployed build, not the dev server**: enrolled a key on the fresh origin, seeded a
€9.00 coupon, and it arrived — `Rosa Green Farm / Organic veg, Saturdays at the market /
79529395…8448 / €9.00 / 1 coupon`, with the row in IndexedDB carrying its expiry. NAP login, the DM
poll, redemption through the legacy scripts, kind-0 branding and the pass all work from the bundle.
Deep links fall back to index.html, so `/farmer/:pubkey` survives a reload. The remaining console
404s are the stack's known gaps (`/api/v1/config`, the merchant profile endpoint) and a 400 for the
already-spent tokens this fresh origin re-polls — identical to dev, none of them assets.

Note the origin change: :4173 is a different origin from the dev server's :5173, so it has its own
IndexedDB and its own enrolled key. Coupons received in dev are not visible there, and cannot be
re-received — their proofs are spent.

## 12. Acceptance

The prototype is done when, against the live local stack:

- A logged-in customer authenticated through real NAP sees a list of farmers they hold coupons from.
- **Pay:** scanning a farmer's `vreqA` QR (or pasting it) opens a confirmation page; confirming
  transfers real vouchers to the farmer and shows a receipt; the transaction is recorded and appears
  in that farmer's history.
- **Receive:** the wallet displays the customer's nip05 as a QR code.
- Selecting a farmer shows their pass carrying their total, and the transactions with them; the pass
  opens their coupon list.

## 13. Passes

Coupons render as wallet passes, at two levels: the **farmer**, carrying everything held from them,
and the **coupon**, carrying its own amount and a redemption QR.

### Where the shape comes from

cashu-voucher **0.10.0** added `cashu-voucher-pass`: `PassJson`, `MerchantBranding` and
`VoucherPassMapper`, a pure `SignedVoucher` → Apple `pass.json` store card mapper. It adopts the
**schema only** — no certificate, no `.pkpass` container, no pass update web service — and it exists
for this wallet. Nothing else consumes it.

`src/lib/pass.ts` is a TypeScript port of that mapper, and `src/components/ui/Pass.tsx` renders it.
The port exists because nothing serves `PassJson` over HTTP and adding an endpoint would mean posting
client-held voucher state to a tier that refuses to hold it — `JdbcWalletPort` rejects voucher
operations outright ("the backend MUST NOT persist vouchers, proofs, or balances"). Constants
(`FORMAT_VERSION`, `PASS_TYPE_IDENTIFIER`, `TEAM_IDENTIFIER`, the colour defaults, `TERMS`,
`BARCODE_PREFIX`) are copied verbatim, because a divergence would silently produce a different card
from the same voucher.

### Where the port deliberately differs

`VoucherPassMapper` throws on a non-ISO-4217 unit, a non-UUID voucher id, and an absent face value or
issuer. That is right for a server mapper and wrong on a render path, where the cost of a malformed
row is a blank screen instead of a slightly wrong card. Every such check degrades instead — and this
stack really does issue in units ISO 4217 does not define, which `formatFace` has always handled.

### The barcode is a redemption code, not a transfer code

`voucher:<voucherId>`, `PKBarcodeFormatQR`. The wallet's *share* QR carries the raw token as an
animated NUT-16 sequence and hands over bearer value; this one carries an identifier the merchant
resolves against the ledger. Conflating them would let a merchant scanning a customer's card receive
the whole token instead of redeeming against it.

The **farmer** pass therefore carries no barcode and no back fields: a barcode is a redemption
identifier for one voucher, and a merchant-level card has no single voucher to redeem.

> imani's own scanner does not yet recognise `voucher:` payloads — it falls through to `UNKNOWN`.
> That is kan card **DEV-131**, on the merchant-scanning side, and does not block a customer wallet
> from displaying the code.

### The deck on `/` — swipe, not slide

`SwipeDeck` in `FarmersPage.tsx`. One **full-width** card per page, no scrollbar
(`.no-scrollbar`, already in `index.css`), dots below. A scroll rail with peeking
neighbours is a *slide*; this is a swipe, and a flick moves exactly one card.

CSS still does the settling — `snap-x snap-mandatory` — because hand-rolling the
animation would mean reimplementing momentum and fighting the browser's own touch
scrolling. Pointer handlers add only what CSS cannot, and only for a **mouse**
(`pointerType !== 'mouse'` returns early): a finger already gets this gesture
natively, with momentum this cannot match.

Three things that are easy to get wrong here, all found by testing the gesture
rather than the markup:

- **Capture on drag, not on pointerdown.** `setPointerCapture` retargets the
  click that follows to the capturing element, so capturing early meant the
  card's link never saw the click and a plain tap silently stopped opening the
  farmer. Capture only once movement passes `TAP_SLOP`.
- **Snapping off during the drag.** `scroll-snap-type: mandatory` keeps yanking a
  hand-set `scrollLeft` back to the nearest snap point. It goes to `none` for the
  drag and back on release, which is what makes the card settle.
- **A short flick must still turn the page.** Settling on whichever card is
  nearest swallows it — a 50px flick leaves the original card nearest. Past
  `SWIPE_THRESHOLD` the deck advances one card in the flick's direction.

`snap-center` was tried and is wrong for a leading rail: no scroll position
satisfies a centred snap for the first card, so mandatory snapping scrolls away
from it on load.

### Branding

`src/lib/branding.ts` reads the farmer's kind-0 through the gateway's existing
`POST /customer/api/v1/nostr/query` — the same query the DM poller uses — and maps `name` /
`picture` / `banner` / `about` onto `MerchantBranding`, exactly the source its javadoc names.

`GET /api/v1/merchant/bootstrap`, the endpoint the Java expects, **does not exist on this stack**:
404 on account-app and customer-wallet, 403 on gateway-portal. It ships in imani-bridge and
imani-merchant, neither of which is in the running compose.

Kind-0 carries no colours, so `backgroundColor` / `foregroundColor` stay at the mapper's dark
defaults for every farmer. Real per-merchant colours would need the bootstrap endpoint.

**Branding is self-declared and unverified, so the pubkey stays on the card.** kind-0 is published by
the issuer about themselves; nothing stops a second pubkey claiming the same `name` and `picture`.
Coupons are per-issuer and the customer pays and redeems against one, so a card showing only a name
and a logo would make picking the wrong "Rosa Green Farm" a real outcome. Every pass therefore also
renders `shortPubkey` of `userInfo.issuer` — a key the mapper's `userInfo` does not have and we add —
under the organisation name, suppressed only when the two are the same string (unbranded, where the
name already *is* the pubkey). This was a regression at first: replacing `FarmerPage`'s header with
the pass removed the last place the pubkey appeared.

**The image URLs are third-party input.** `picture` and `banner` come from a host the issuer may
control, and fetching one hands them the customer's IP and the moment they opened their wallet. There
is no CSP on this app. `brandingFromKind0` therefore allows only `https:` and `data:` — an allow-list,
parsed with `new URL(raw)` and **no base**, because a base silently resolves `//evil.test/x` and even
`not a url` into an accepted https URL. Both `<img>` tags send `referrerPolicy="no-referrer"` and load
lazily, and `Avatar` falls back to initials on error rather than showing a broken image. None of that
stops the beacon itself — only a proxy or a CSP would.

A farmer with no kind-0 published renders a correct pass with the issuer pubkey as its name — verified
before the branded path was, because that is what a fresh farmer looks like.

## 14. Accounts — registration, login, profile, logout (2026-08-13)

The wallet had no account experience: `LoginPage` unlocked an already-enrolled nsec and nothing else,
there was no header, no profile, no settings, and — as §11.9 recorded — no logout at all. The UX is
ported from `bottin-client-ui` (register → back up → unlock → edit profile → log out), **minus the
lightning address**, which this wallet has no use for.

`bottin-client-ui` is not in this stack; the `bottin-web` container serves `bottin-api`, the REST API
only. So the *experience* is ported, not the endpoints.

### 14.1 Why registration can live here now

§5 said registration belonged to bottin. Two things make it the wallet's own:

**The handle claim.** `POST /api/v1/nip05` on account-app takes a raw pubkey — the non-custodial mode,
no bunker — and performs the HTTP-Basic leg to bottin-api itself. It is **NIP-98** authenticated, not
session authenticated, which is the load-bearing detail: a signature over the request is the entire
credential, so the claim can be made by a signer built from a freshly minted key, before any session
exists. Verified live: 201 with a real directory record, 409 `NIP05_002` on a duplicate.

**Kind-0 writes.** The wallet publishes profile metadata straight to strfry over a WebSocket.
`deploy/compose.override.yml` already published that port for this purpose. The gateway's own publish
endpoint (`POST /api/v1/profiles/{pubkey}/events`) is **stubbed** while `GATEWAY_BUNKER_MOCK=true` and
throws "Profile services not configured" — do not reach for it when a publish fails.

### 14.2 The ordering property

Registration runs: **mint key → claim handle → store key → save profile → publish kind-0 → stash the
backup key → log in.** Two separate correctness rules are encoded there, and both were learned the
hard way.

*Claim before persist* is bottin's rule: a browser must never hold a key asserting a NIP-05 that
belongs to someone else.

*Log in last* is ours, and bottin cannot follow it — its own register endpoint reads the pubkey from a
session cookie, so it must log in first. Ours does not. This matters because logging in flips the app
from the public route tree to the authenticated one, remounting it. An earlier version logged in
first, and in a browser that produced two defects at once: the backup screen never appeared (the nsec
was stashed *after* the remount had already looked for it) and the header rendered an empty profile.
With login last, a failed claim leaves no session, no stored key and no profile, and the user is still
on the form with their handle to correct. Locked down by `src/lib/__tests__/registration.test.ts`.

### 14.3 Reads and writes go to different stores

**The single most surprising thing here.** The wallet PUBLISHES kind-0 to the relay, but READS it back
through `POST /customer/api/v1/nostr/query`, the gateway's nostrdb cache. These are different stores
and the cache can lag indefinitely.

Observed: rename yourself, log in again, and the name silently reverts — `refreshProfile` fetched the
cached pre-rename event and merged it over the newer local record, with no error anywhere. Exactly the
"looks like success" failure the handoff warns about.

The fix is replaceable-event semantics done properly. `Profile.eventAt` holds the `created_at` of the
kind-0 a record's contents came from, and `mergeKind0` ignores any event that is not strictly newer.
Anything that publishes — registration and the profile editor — stamps `eventAt` from the event it
signed, *before* the publish can fail. `updatedAt` cannot serve this purpose: a local save and a remote
event have unrelated clocks and meanings.

### 14.4 Key custody, backup and logout

The key stays in nap's WebCrypto keystore. The new local record beside it (`imani-wallet:profile:<pubkey>`)
holds **public metadata only** — the same fields any relay would hand a stranger. bottin's equivalent
also carries the encrypted key and a PBKDF2 password verifier; we keep neither, because nap's keystore
owns the key and already fails the decrypt on a wrong passphrase.

The backup file carries nap's **own encrypted envelope verbatim** plus the profile. No second
encryption scheme, nothing weaker than the thing it backs up, and self-describing (the KDF parameters
travel with it). Writing the nsec into a file instead would put plaintext key material on disk.

**Logout is destructive**: it clears the keystore, so it erases the key rather than only ending the
session. The coupons in IndexedDB survive but are unusable without the key, and there is no password
reset — the confirmation says so in those terms rather than bottin's milder "erases your key from this
browser". Backup exists so this is recoverable, which is why it shipped alongside.

### 14.5 Availability checking is advisory, and cannot be otherwise here

`GET /api/v1/resolve/{nip05}` does an **external** NIP-05 lookup — it fetches
`https://{domain}/.well-known/nostr.json` — and never consults the directory the claim writes to.
On this stack `imani.local` does not resolve publicly, so it answers 404 for handles that
demonstrably exist and therefore always reports "available" (confirmed against a live record; the
account-app log line is `nip05_resolve_external`). In production against a real domain it works.

So the badge is a hint and **the 409 from the claim is the authority**. The form never gates
submission on the badge.

Related trap: bottin's form allows `[a-z0-9_-]`, the gateway validates `^[a-z0-9_]+$`. Using bottin's
rule would accept `farm-stand`, show it available, and fail at the claim after a key had been minted.
`validateHandle` uses the gateway's.

### 14.6 Stack setup this depends on

Both are config, both were silent failures, and `scripts/seed-domain.sh` plus `compose.override.yml`
now carry them:

- **`BOTTIN_PASSWORD` on account-app.** gateway-core's `application.yml:106` falls back to
  `MERCHANT_IDENTITY_BOTTIN_PASS`; the compose sets `..._PASSWORD` (as line 258 of the same file does
  for the same credential). The fallback name is a typo, so the password never bound and every claim
  threw "Bottin write credentials are not configured", after a boot warning nobody was reading.
- **The domain must exist and be verified in bottin.** A fresh stack has no domain row: claims fail
  `404 DOMAIN_NOT_FOUND`, then `412 DOMAIN_NOT_VERIFIED` once registered. Bottin verifies by DNS TXT or
  well-known file and `imani.local` can satisfy neither, with no flag to skip it, so the seed script
  sets the bit directly in bottin's DB. Test-stack only.

### 14.7 Verification status

Verified in a real browser against the running stack, 2026-08-13:

- register `market_alice` → **201**, real record in bottin, kind-0 on the relay read back off strfry
- backup screen shown, gated on its checkbox; **409** on a duplicate handle
- header avatar and its Profile / Settings / Log out menu
- profile edit → "published to 1/1 relay", **content confirmed on the relay**, no `lud16`
- rename → log in again → name survives (the §14.3 regression, re-tested after the fix)
- change passphrase → old passphrase rejected, new one accepted
- reveal nsec → wrong passphrase rejected; revealed key matches the registration backup key
- logout → localStorage and sessionStorage empty, lands on `/onboarding`
- restore from the downloaded backup file → unlocked back into the account

Not verified: avatar/banner upload to Blossom (the configured host is the public
`blossom.primal.net`; the input is enabled and the code path is imani-apps' `@imani/blossom-upload`
used whole, but no file was actually uploaded). Coupons were not exercised against a registered
account — the flows in §11 were verified for the demo customer, not for one created this way.

### 14.8 Code review, and the two data-loss bugs it found (2026-08-13)

A review of the account code found ten issues; all were real and all are fixed. Three could have cost
a user their account, and they share a shape worth naming: **each one destroys or misdirects key
material along a path nobody walks in a happy-path test.**

**Restore destroyed the key it was meant to protect.** `restoreBackup` wrote the encrypted envelope
into localStorage the moment a file was *chosen* — before asking for a passphrase. `/restore` is
linked from the login screen, i.e. from a browser that already holds a key, so picking the wrong file
or misremembering its passphrase overwrote the only encrypted copy of the key already there. The app
itself tells the user that is unrecoverable. Now split into `parseBackup` (validates, writes nothing)
and `applyBackup` (snapshot → write → verify by decrypting → **roll back on failure**). Verified in a
browser with a foreign backup file: wrong passphrase, error shown, original key intact and still
unlocking.

**A failed login left a session pointed at the wrong key.** `createSession` returns the cached session
and ignores the key it is handed. If `login()` rejected, the module singletons stayed set to key A
while React state stayed `null`, leaving the public routes up. Importing key B then reached
`onUnlock(B)`, got handed session A, and the app ran as A while the keystore held B —
`getSigner()`, `openWallet()` and the DM poller all on the wrong pubkey, silently. `onUnlock` now
calls `resetSession()` before rethrowing.

**The backup key was shown to the wrong account.** The pending-nsec stash was a single unkeyed
sessionStorage slot. Register A, leave the backup screen without ticking the box, refresh (the
session is in memory, so the app drops to `/login`), import key B — and B's welcome screen rendered
A's nsec under B's handle. The user writes down the wrong key while B's enrolment has already
overwritten A, losing both. The stash is now `{pubkey, nsec}` and only returns to a matching pubkey.

The rest, briefly:

- `href={profile.website}` had no scheme guard, though `validate.ts` exists saying `javascript:` is a
  URL too. The check only ran in the edit form, while `website` also arrives from kind-0 and from a
  restored backup file. `webUrl()` now guards it on the read path, as `imageUrl` already did for
  `picture`/`banner`, and `sanitiseProfile` cleans anything arriving from a file.
- A login failure *after* a successful claim made the retry report the user's **own** handle as taken,
  pushing them to claim a second handle for one key. `pending.claimedHandle` skips the re-claim.
- `setAvailability('taken')` fired on every registration failure, so a gateway 500 or
  `DOMAIN_NOT_VERIFIED` painted "Already taken" under a perfectly free handle, contradicting the error
  shown below it.
- `isHandleAvailable` returned `false` for any non-404 — a 500 or a proxy 502 read as "taken". Only
  200 means taken now; anything else throws and shows no verdict.
- Importing a key ran `saveProfile(emptyProfile(pubkey))` first, erasing the handle and name of an
  account this browser already knew — recovered only if the gateway's cache happened to hold a kind-0.
- A backup file's `profile` was written with no shape check: no `pubkey` meant
  `imani-wallet:profile:undefined`, which then broke the login recognition card (it counts stored
  profiles and expects one).
- The nsec copy button swallowed a clipboard rejection, leaving the user believing their only backup
  key was on the clipboard when it was not.

Regression tests: `backup.test.ts` (rollback, including the no-previous-key case),
`onboardingHandoff.test.ts` (never hand one account another's key), plus a registration case for the
retry-after-failed-login path. 188 tests green.

## 15. The merchant role (2026-08-13)

The wallet now serves both sides of the stall. Registration asks Customer or Merchant; a merchant
gets a different home (**Sell** / **Redeem** in place of Pay / Receive), a merchant section in
settings, and the metadata that issuance needs. This is the first half of merging `possa-merchant`
in; the dashboard and the list pages are phase 2.

Almost none of possa-merchant's code came across. Four findings from the running stack are why.

### 15.1 `/api/v1/merchant/*` does not exist on this stack

possa-merchant's whole backend onboarding surface — `GET /merchant/bootstrap`,
`/merchant/onboarding/*`, `/merchant/identity/username-availability`, `/merchant/identity/reach`,
`/merchant/payment-requests/check` — is **absent from gateway-portal**.

The evidence is a calibration, not a guess: a path this portal has never heard of
(`/api/v1/definitely-not-a-route`) answers **403 with an empty body**, and every `/api/v1/merchant/*`
path answers identically. `/api/v1/portal/*` answers 401 `NIP-98 authentication required` — route
present, auth required — and an unknown sub-path under it answers 500. Three distinct responses, so
403-empty reliably means "no such route" here.

So merchant metadata has no backend to live in, which settled the design: it is a **kind-30078
addressable event, `d=imani:merchant`** — possa-merchant's own convention, from its
`lib/merchant/writeContract.ts` — published straight to the relay. `lib/merchant.ts` owns it, and
carries the same `eventAt` ordering guard as `mergeKind0` for the same reason (§14.3).

**Role is derived, never stored twice.** A merchant is a pubkey with a live `imani:merchant` record;
`isMerchant()` is a type predicate over that. A separate role flag would be a second place to
disagree with the metadata that Sell and Redeem actually need.

Reads go **straight to strfry** via `newestAddressable()` in `lib/relay.ts`, not through the
gateway's nostrdb cache — it lags (§14.3), and it ignores standard tag filters in favour of its own
`pTags`, so `#d` is a suggestion. The result is re-filtered locally.

### 15.2 The portal's NIP-98 filter does not authenticate — the edge path is the only one

This cost the session's one real debugging round, and the failure looks exactly like a signing bug.

A **correctly-formed NIP-98 header, whose `u` tag matches exactly, sent DIRECTLY to :28084 with no
proxy in the way**, still returns 401 `NIP-98 authentication required`. The same request with
`X-Auth-Pubkey` + `X-Edge-Auth` returns 201. So `Nip98AuthFilter` is not authenticating on this
image; only `NapProxyAuthFilter`'s edge path is. That is what `scripts/seed-farmer.mjs` means by
"whichever the deployed portal build honours wins" — on this stack it is always the edge one.

The fix is not to put the shared secret in the browser: `X-Auth-Pubkey` is caller-supplied, and the
secret is the only thing vouching for it, so shipping it would let anyone issue as anyone. Instead
**Vite plays the edge proxy it is already standing in for** — the page sends only its own pubkey and
the `/api/v1/portal` proxy rule adds the secret, which stays in `vite.config.ts` and never enters the
bundle. Read from `process.env.PORTAL_EDGE_SECRET`, deliberately not a `VITE_`-prefixed var, since
those are inlined into client code.

Marked `ponytail:` — it trusts whatever pubkey the page claims, which is as much as a local stack can
check. It goes the moment the portal's NIP-98 path works or a real edge proxy appears.

### 15.3 Sell is `seed-farmer.mjs`, not anything from possa-merchant

The flow the merchant wants — scan a customer's npub, type an amount, send — exists in neither app's
merchant UI. possa-merchant's nearest equivalent is cashback: a **bearer QR with a one-time claim
key that deliberately never learns who the customer is** (its FR-018). Addressing a coupon to a
pubkey is a different thing.

But it already existed here, verified, as a script. `lib/issue.ts` is `scripts/seed-farmer.mjs`
moved into the app, with `signedFetch` in place of its hand-rolled NIP-98 and the edge secret
dropped. Its three waits are all load-bearing:

1. `POST /api/v1/portal/vouchers` — the issuer pubkey is never a request field, it comes from whoever
   the portal authenticated.
2. Poll `GET /api/v1/wallet/vouchers/{id}` until `token` is present **and** `status === 'ISSUED'`.
   Issuance returns PENDING behind a Lightning top-up that phoenixd-mock settles ~2s later; sending
   earlier DMs an empty token. Poll on **`token` presence, not `expires_at`** — that stays null for
   5-10s after ISSUED, so it is not a readiness signal.
3. Then a bounded grace re-read until `expires_at` settles, and only then `POST /api/v1/dm/tokens/send`
   with `expires_at` as **epoch seconds**. Omitting it is why every seeded coupon once arrived
   expiry-less; sending milliseconds dates it to the year 58000.

`relay_urls` must be the **gateway-reachable** url (`ws://nostr-relay:7777`), not the browser's
published port — the gateway publishes from inside the compose network. Hence `INTERNAL_RELAY_URL`
beside `RELAY_URL` in `lib/relay.ts`.

The UI holds the merchant through all of it rather than confirming early: on a market stall, a
delivery that fails in the background is discovered after the customer has walked away.

### 15.4 Redemption needs no polling endpoint

possa-merchant polls `/merchant/payment-requests/check` every 30s. That endpoint does not exist here
(§15.1), and it turns out nothing needs to.

`lib/pay.ts`'s `buildSendParams` sets `recipientPubkey: request.issuerId`, and the
`POST /api/v1/atomic-send` saga DMs the token to that pubkey. A merchant running this wallet already
has `startDmPoll` going, so a customer paying a merchant's request arrives through **the ordinary
receive pipeline** — the one §11.6 already proved. `RedeemPage` therefore watches `onWalletChanged`.

The generator was already in the page too: `window.NUT18V` (loaded as a classic script by `main.tsx`)
exports `generate`, `parse`, `generatePaymentId` and `isExpired`. possa-merchant's
`lib/vreq/nut18v.ts` and `cborg` were **not** ported — its field order matches
`VoucherPaymentRequest.java`'s `@JsonPropertyOrder`, and a second encoder would have to keep matching
it forever. What *was* ported is the matching discipline from `fulfillPaymentRequest`: dedupe by
payment id and send id, exact-id match first, amount+unit fallback **only when exactly one request
matches**, underpayment rejected and overpayment accepted.

### 15.5 Two stack traps worth knowing

- **customer-wallet's relay ingest pump dies.** Its nostrdb cache answers
  `raw_query query_complete total=0 source=local+relay` for everything, and dm-poll reports "Fetched
  0 gift wrap events" while the relay plainly holds the wraps. `docker restart customer-wallet-test`
  revives it (`relay_ingest_event_stored` then replays the backlog). Its health endpoint reports
  `OUT_OF_SERVICE` **even when it is working**, so health is not the signal — query the relay
  directly and compare.
- **`GET /api/v1/portal/vouchers` returns `{"items":[]}`** for a merchant that has just issued
  successfully. Phase 2's issued-coupons page is built on this endpoint, so what actually populates
  it needs establishing before that page is trusted.

### 15.6 What was verified, and what was not

Verified by observation, not by green screens:

- The kind-30078 landed on strfry (`query-relay.mjs … 30078`), and clearing the local copy then
  reloading recovered the merchant home **from the relay alone**.
- Two sales delivered: kind-1059 gift wraps addressed to the customer appeared on the relay at the
  matching timestamps, and the DM request body carried `expires_at: 1789246394` — a **number, in
  seconds** — with `relay_urls: ["ws://nostr-relay:7777"]`.
- The coupon arrived in the customer's wallet at €3.00, memo intact, issuer resolved to the merchant's
  handle, and **"Expires Sep 12, 2026"** — a real date, which is the §15.3 trap not firing.
- A customer account sees exactly the old app: "Coupon wallet", Pay/Receive, no merchant routes.
- The vreq round-trips through the shim: issuer = merchant pubkey, €4.25 as 425 minor, single-use, 24h.

**Not verified end-to-end: a customer actually paying a Redeem request.** The receive pipeline it
relies on is proven (the coupon above arrived through it) and `matchPayment` is unit-tested, but the
live flip from "Waiting for payment" to "Paid" was not exercised — one browser profile holds one key
at a time, so merchant and customer cannot both be live in it. Treat it as unproven until run.

Checks: `npx tsc -b --force` clean, `npx vitest run` 230 green (35 new, covering the `eventAt`
ordering guard, `toEpochSeconds`, npub resolution, payment matching and amount parsing).

### 15.7 Merchant settings, and the role becoming two-way (2026-08-13)

`/settings/merchant` began as a bare edit form for the metadata. Three things were missing, and
they turned out to be the same thing seen from different sides.

**`active` had no UI.** It sits in `MerchantProfile`, `isMerchant()` reads it, and therefore the
entire role hangs off it — but nothing could ever set it to `false`. A farmer who stops trading had
no way to say so. It is now an **Open for business** switch at the top of the page.

**That switch is a trap if the route is gated on `isMerchant()`.** Turning it off makes
`isMerchant()` false, which would remove `/settings/merchant` — leaving the switch off and
unreachable forever. So the route and the settings row are gated on **`merchant !== null`** (a stall
record exists, open or closed) while only the *trading screens* — the merchant home, `/sell`,
`/redeem` — are gated on `active`. A closed stall reverts to the customer home and keeps its
settings row.

**A customer could never start selling.** §15.1's "role is derived, never stored twice" makes the
upgrade almost free: a merchant is a pubkey with an `imani:merchant` record, so opening a stall is
publishing that record, with no new account and no migration. The same page does both jobs —
`merchant` is nullable, a null one starts from `emptyMerchant(pubkey)`, and the settings row reads
"Start selling" instead of "Your stall". This closes the gap that the registration screen carried a
`ponytail:` note about; the note is gone because the upgrade exists.

`Switch` moved from OnboardingPage into `components/ui/Switch.tsx` and the barrel, now that
registration and settings both use it.

Verified: closing a stall published `active:false` to the relay, reverted the home to Pay/Receive
and the header to "Coupon wallet", and **left the settings row in place**; reopening restored
Sell/Redeem. A fresh customer (`daisy2`) went Settings → Start selling → merchant home, and
`query-relay.mjs … 30078` shows the kind-30078 it published.

Still deliberately absent — Network/NIP-65, Stripe, LNbits and Sync from possa-merchant's 975-line
settings page. Nothing on this stack serves them.

### 15.8 Which stall questions belong where (2026-08-13)

`MerchantFieldset` now takes a `mode`, because setting a stall up and editing it later are the same
record but not the same set of questions.

- **create** — business name, categories, description, coupon validity. **Location and currency are
  not asked.** Neither is needed to make the first sale, and the currency has a working default, so
  neither earns a question from someone registering at a market stall.
- **edit** — adds location and currency, and shows **validity read-only**.

Validity is chosen once and fixed after. The create screen says so *before* the choice ("Choose
carefully — this cannot be changed later") rather than after it is locked. In edit mode it renders as
a plain value, not a disabled control: greyed-out buttons read as "temporarily unavailable" and
invite a hunt for whatever re-enables them, and nothing will.

Currency stays editable, and the existing footnote about already-issued coupons keeping their unit
now only shows in edit mode, since there is no currency field while creating.

Verified: onboarding's stall step no longer renders location or currency, a validity of 90 chosen
there persisted, and a settings save that changed currency to XAF and added a location left
`voucherValidityDays: 90` untouched. The currency change reached the Sell screen — "Amount (XAF)",
`inputMode="numeric"`, placeholder `0` — which is `currencyDecimals` correctly treating XAF as
zero-decimal.

### 15.9 Merchant history, and a currency trap (2026-08-13)

Two screens, `/merchant/transactions` and `/merchant/coupons`, plus the last three movements on the
till itself with links to both.

**`GET /api/v1/portal/vouchers` is not the source, despite appearing to be.** §15.5 recorded it
returning `{"items":[]}` after a successful sale; the controller says why.
`PortalDashboardService.allMerchantVouchers` merges exactly two things — kind-30078
`possa:payment-requests` / `possa:paid-vreqs` events off the relay, and gateway-portal's
`cashback_record` table — and its own javadoc states customer-wallet "is intentionally NOT
consulted" because `WalletPort#listVouchers` is a deliberate `UnsupportedOperationException`.
Coupons issued through `POST /portal/vouchers`, which is the Sell flow, are in neither.

So the merchant's history is client-held, which is what Constitution Principle II asks for anyway —
the merchant is a client. `issueAndDeliver` now writes a `type: 'issued'` transaction row on success
(non-fatal, never silent, mirroring `payRequest`), and both screens read that store. Issued coupons
are the outgoing subset; the transactions list is everything, redemptions included, since those
already arrive through the receive pipeline.

**Not saved as vouchers.** `listVouchers()` feeds `walletTotals`, so filing a coupon the merchant
gave away as one they hold would put money on screen that does not exist.

#### The currency trap, and the fix that was worse

The list showed `FCFA 25.00` for a sale confirmed as `FCFA 2,500`. The gateway stamps
**`face_decimals: 2` on every voucher regardless of currency** — probed directly:
`face_value_minor: 1000` returns `JPY 10.00`, `XOF 10.00` and `€10.00` alike, though JPY and XOF have
no minor unit.

The obvious fix — scale the merchant's input by the gateway's convention so the two agree — is
**wrong, and worse than the bug**. Backing runs at `issuance_ratio: 1.0`, one minor unit per sat, so
2500 XAF became a request for 250,000 sats: a hundredfold over-backing whose token was too large to
deliver. Observed as a flat **413** from `POST /api/v1/dm/tokens/send`, with the coupon issued and
stranded. Reverted.

What stands: input scales by ISO decimals (`currencyDecimals`), which keeps the sats magnitude and
the delivery working, and the merchant's own history renders with the currency's decimals rather
than the voucher's, so the till and the history agree at `FCFA 2,500`.

**Unfixed, and a backend defect:** the coupon still travels with `face_decimals: 2`, so a *customer*
opening a 2,500 XAF coupon sees `25.00`. Only zero-decimal currencies are affected — EUR, USD and
the rest are 2 either way. Until gateway-portal derives decimals from the currency, either restrict
the issuance list in `lib/merchant.ts` to 2-decimal currencies, or accept that XAF/XOF/JPY coupons
are mislabelled by a factor of 100 on the customer's screen. Do not paper over it in the wallet.

### 15.10 Transaction ↔ coupon, and one way in (2026-08-13)

A transaction detail now offers **View coupon**, rendered in `ListSection`'s existing `action` slot —
the same place `SeeAll` sits elsewhere. It routes two ways, because the coupon behind a movement is
not always in this wallet:

- `type: 'issued'` → `/merchant/coupon/:voucherId`. The merchant gave this coupon away, so there is
  no voucher row and `/coupon/:tokenId` would find nothing. `IssuedCouponPage` rebuilds the detail
  from the issuance transaction, which is the merchant's only copy (§15.9).
- anything carrying a `tokenId` → the existing `/coupon/:tokenId`.

The issued-coupon detail shows amount, memo, status, issued and expiry dates, the customer, the
coupon id and **the transaction id**, and its back-link returns to that transaction. Status is only
ever "Issued" or "Expired": whether the customer has spent it is not knowable from here — it is
bearer value in their wallet — and a status the app cannot stand behind is worse than none.

The till lost its **Issued coupons** link. Coupons are now reached through the movement that created
them, so a second link straight to the list would be a parallel route to the same records, and its
absence is what makes the coupon page's back-link to the transaction coherent. `/merchant/coupons`
still exists and still works; nothing links to it today.

Verified: till → transaction → View coupon → coupon detail carrying `Transaction id
issued:a8f85cac…` → back-link returns to that transaction. The `tokenId` branch is exercised by code
inspection only — this merchant holds no received coupons, and one browser profile holds one key.

### 15.11 Expiring soon, and Stats (2026-08-13)

**Expiring soon** on the till: issued coupons inside a 7-day window, soonest first, matching the
`expires_within_days=7` filter possa-merchant's ExpiringPanel uses. Already-expired coupons are
excluded — nothing can be done about them, and they would bury the ones that can still be spent. The
section is absent rather than empty when there is nothing to act on: an "Expiring soon (0)" box every
day teaches a merchant to stop reading it, so its presence IS the signal.

**Stats** at `/merchant/stats`, reached from the account menu (merchants only). possa's three
dashboard panels — five metric tiles, the status snapshot, daily activity — over a 7/30/90 day range.

#### It cannot use the endpoint possa uses

`GET /api/v1/portal/dashboard/composite` is live here and answers 200. It answers with **zeros** for
a merchant who has issued three coupons:

```
{"dashboard":{"vouchers_issued":0,…,"value_issued_minor":0,…},
 "activity":{"series":[]},"status":{"active":0,…},"expiring":{"vouchers":[]}}
```

Same cause as §15.9: it is fed by `allMerchantVouchers`, which cannot see Sell-flow coupons.
Rendering it would be a dashboard of lies, so `lib/stats.ts` computes the same shapes from this
wallet's own rows — the only record those coupons have.

#### What the numbers can honestly say

- **Redemptions are matched by issuer.** A merchant is also a customer, so coupons received from
  another farmer arrive as incoming rows too. Only incoming rows whose issuer is this merchant count
  as redemptions; anything else would inflate the rate with unrelated money.
- **One currency at a time**, like `walletTotals`. Records in other currencies are excluded and
  *counted*, and the screen says how many — dropping them silently is a quieter lie than summing them.
- **No "redeemed" or "revoked" status row**, which possa's snapshot has. A coupon is bearer value in
  the customer's wallet until it comes back, and there is no revoke on this stack. "Came back" counts
  what actually returned, which is the answerable version of the question.
- The screen says outright that these are this device's records, not the gateway's ledger.

**No chart.js**, despite the earlier decision to port it. possa lazy-loads ~60KB for its activity
chart; this series is a few integers per day and CSS bars draw it with no dependency. Revisit when
it needs axes, tooltips or zoom.

#### An off-by-one the tests caught

Zero-filling `ceil((now - from) / DAY)` buckets forward from the first day stops one short: today's
rows land past the last bucket and vanish. A busy afternoon rendered as an empty chart. Buckets now
run `dayOf(from) … dayOf(now)` inclusive, and callers pass `from = now - (days - 1) * DAY` to get
exactly `days` columns — verified as 7, 30 and 90 in the browser.

Verified: Expiring soon absent with no near-expiry coupons, then rendering "Bananas · Expires Aug 16
· FCFA 1,500" once one existed; Stats showing 4 issued / 1 returned / FCFA 9,000 / FCFA 800 / 25%.
The expiring coupon and the redemption were **injected into IndexedDB** — the UI cannot issue a
coupon expiring inside 7 days (30-day minimum validity) and no live redemption has been run yet
(§15.6). Both rows were removed afterwards.

### 15.12 The books follow the key, not the browser (2026-08-14)

§15.9 put the merchant's issuance history in IndexedDB because nothing else had it. That made logout
a false promise in one direction and a data-loss event in the other: it left a readable ledger of
someone's takings on a shared device, and a new phone meant every sale ever made was gone, with
Stats resetting to zero. The backup file did not help — `BackupFile` is `{ key, profile }`.

**Every issuance is now published as an addressable kind-30078 event, `d=imani:issued:<voucherId>`,
NIP-44 encrypted to the merchant's own key.** One event per coupon, so each is replaceable on its own
and the set is restorable. The stall record stays plaintext — a stall's categories are public by
design; its takings are not — so a relay holds one readable event and N opaque ones per merchant.

The Cashu token is deliberately NOT in the record. That is bearer value; this is a ledger, not a
wallet.

`WalletSigner` gained `nip44Encrypt` to match its existing `nip44Decrypt`. Encrypting to
`signer.pubkey` works because NIP-44's conversation key for (k, K) is the same either way round.

**Logout now wipes the device**: `wipeWallet()` closes and deletes `imani-wallet-<pubkey>`, and every
`imani-wallet:*` localStorage key goes, by prefix rather than by name — that list has grown three
times already and would silently break the promise the fourth time. The database must be closed
first or `deleteDatabase` blocks forever on the open connection: it never rejects, so the logout
would hang with the key already destroyed.

**Login restores.** `restoreIssued()` queries the relay for the prefix, decrypts, and writes rows
back; `backfillIssued()` publishes anything the relay is missing, which closes the gap for sales made
before this existed. Both run after `setReady` — a background reconciliation, not something to hold
the app on a network round-trip for — and neither throws.

`allAddressable()` in lib/relay.ts is the list counterpart of `newestAddressable`: filtering is by
`d` PREFIX and done client-side, because a relay cannot match prefixes and a `#d` list would mean
knowing every voucher id before asking for it. De-duplicated by `d` keeping the newest, since a relay
is not obliged to have dropped a replaced copy.

#### Verified end to end

1. Login back-filled the three existing sales; `query-relay.mjs … 30078` then showed **four** events —
   one plaintext stall record and three opaque ciphertexts.
2. Logout left `localStorage` with **zero** `imani-wallet:*` keys and `indexedDB.databases()`
   **empty**.
3. Logging back in with **only the nsec** rebuilt the merchant identity ("rosafarm6 / Rosa's Market
   Garden"), all three sales, and Stats at 3 issued / FCFA 7,500 / 3 still valid.

Held coupons are the exception and always will be: they return through the DM pipeline as they are
re-received, and one already spent does not come back — which is correct.

## 16. NAP roles and permissions (2026-08-14)

The role was answered entirely client-side: `isMerchant()` over a kind-30078 stall record, with
`gateway-portal` having no authorization at all — zero `@PreAuthorize`, and `NapProxyAuthFilter`
granting every edge-proxied caller one flat `ROLE_NOSTR_USER`. Anyone could POST
`/api/v1/portal/vouchers` and issue coupons as themselves. This section is the boundary being made
real. Plan: `~/.claude/plans/merge-possa-merchant-into-imani-wallet-recursive-bubble.md`.

### 16.1 Phase 1's honest status: the code was fine, the database was not

`mvn -pl gateway-core-rest test` — the full run, not `compile` — is **green: 646 tests, 0 failures,
from a `clean`** so all 75 test sources were recompiled. The earlier worry that test scope had never
been compiled was real when written and is now closed; whatever `NapProperties` breakage existed had
already been fixed.

**The upgrade is still not deployable, and the reason is not in the code.** nap 0.6.0's
`JdbcSessionStore` reads `refresh_token` in its row mapper — on *every* session read — and names all
three RFC §14.1 columns in its insert. nap-jdbc ships them in its own
`V3__sliding_window_and_refresh_tokens.sql`, but gateway-core does not run nap's migrations:
`flyway.locations` is `classpath:db/migration/core` alone, so nap's files sit on the classpath and are
never applied. `\d nap_sessions` on the live `imani_core` confirmed the columns were absent. The
sliding-window half of nap's V3 had been hand-copied here long ago as V23; the refresh half never was.

So a rebuilt account-app would compile, pass 648 tests, boot — and fail on the first login, against a
database that looks fine. Closed by `V31__nap_sessions_refresh_tokens.sql`, applied and verified:

```
ALTER TABLE ×3, CREATE INDEX ×2
\d nap_sessions → refresh_token | refresh_expires_at | previous_refresh_token
```

Additive and nullable, so the currently-deployed 0.1.1 image is unaffected — confirmed by
`/actuator/health` still UP afterwards.

### 16.2 The task-2 gate, re-examined — and a worse problem behind it

Repointing `MerchantAclService` from `nap_acl` to the kind-30078 stall record was carded as blocked on
the nostrdb cache. Two findings change the picture.

**account-app already has a relay-backed read path.** Its own startup log:

```
nostr_gateway relay_connected url=ws://nostr-relay:7777 auth_required=false outcome=connected
Creating CachingNostrGatewayDecorator with relay fallback, cache_freshness=PT30M
Creating NostrQueryPort adapter (local-only mode: false)
```

This is not customer-wallet's ingest pump (the one that dies, §15.5); it is a separate
`NostrQueryAdapter` in the same JVM as the resolver, querying strfry directly on a miss.
`RelayListService` already reads kind-10002 by author through it.

**And the gate does not apply to this query.** An earlier draft of this section claimed
`NostrQueryAdapter.query` could starve it: ask the caching gateway by kind + author, filter by `#d`,
get nothing, fall back to a **local-only** re-query. That branch is real, but it cannot fire for the
stall record, because `CachingNostrGatewayDecorator` skips the relay **only for kinds that are not
addressable-replaceable**:

```java
boolean allKindsAreCacheable = rawKinds != null && rawKinds.length > 0
        && Arrays.stream(rawKinds).noneMatch(CachingNostrGatewayDecorator::isAddressableReplaceable);
// isAddressableReplaceable(kind) → kind >= 30000 && kind < 40000
```

Kind 30078 is in that range, so the relay is consulted on **every** such query, with the `#d` filter
attached — deliberately, because chunk reassembly for addressable kinds needs the relay-authoritative
set. A stale or empty local cache therefore cannot make a live merchant read as a customer. Confirmed
by observation, not by reading: closing a stall while the probe container's nostrdb already held the
`active: true` copy still revoked issuance on the next login (§16.6).

**The real blocker was the ACL table, and it was empty.** `select count(*) from nap_acl` → **0**, and
the resolver read the role from it. So every caller resolved to `customer`, nobody was granted
`coupon:issue`, and with Phase 3 enforcing, every Sell would have 403'd. Repointing the role source
was therefore not cleanup — it was the thing that makes any of this grant anything at all. Done in
§16.6.

### 16.3 Phase 3 — enforcement on the portal, verified against a running image

The portal cannot validate a NAP session: account-app is on `imani_core`, the portal on
`imani_portal`. So capability crosses the same boundary identity already does — the edge.

1. **gateway-core** — `/api/v1/auth/validate` now answers with `X-Auth-Permissions` beside
   `X-Auth-Pubkey`, and `permissions` in the body. Always present on a 200, **empty rather than
   absent** when there are none, so an edge proxy cannot read "resolved to nothing" as "header
   missing, forward the client's".
2. **gateway-portal** — `NapProxyAuthFilter` parses it (comma-separated, trimmed, de-duplicated,
   capped at 32) into `SimpleGrantedAuthority` values verbatim, beside the existing
   `ROLE_NOSTR_USER`. It is read **only inside the trusted-edge branch**, so CRIT-4's fail-closed
   rule covers capability exactly as it covers identity. The OPS requirement widens with it: the edge
   MUST strip inbound `X-Auth-Permissions` too.
3. **`PortalVoucherController`** — `@PreAuthorize("hasAuthority('coupon:issue')")` **at class level**.
   Per-method would leave the next handler someone adds silently public, which is the fail-open trap
   NAP's docs name; nothing on this controller belongs to a non-merchant.
4. **The wallet's Vite edge** — a `portal-edge-auth` middleware now performs the `auth_request` step
   a real nginx does: strip both inbound headers, `GET /api/v1/auth/validate` with the request's
   cookie, and inject the pubkey and permissions from the answer. Fails closed — an unreachable or
   401 validate leaves no pubkey, so the proxy rule adds no secret and the portal refuses. This
   **retires the ponytail note in §15.2**: the pubkey is no longer whatever the page claimed, it is
   whatever the session store says. `signedFetch`'s `extraHeaders` parameter went with it, having
   lost its only caller.

**`@PreAuthorize`, not NAP's `@RequiresPermission`** — a deliberate deviation from the plan. Spring
Security is already a dependency here and nap-spring is not; adopting it for one annotation would
drag in five nap artifacts plus `NapPermissionInterceptor`, and nap-java 0.6.0 is not in this
service's BOM (and `imani-bom 0.1.40` is local-only, so CI would not see it). The permission string is
the contract, not the annotation.

#### A denial that read as an outage

First probe against the built image: **500 `{"error":"Internal server error"}`**. `GlobalExceptionHandler`'s
`@ExceptionHandler(Exception.class)` catches `AuthorizationDeniedException` before Spring Security's
own translation ever sees it, and a `@ControllerAdvice` runs first. A refused permission presenting as
a server fault sends the caller looking for an outage and hides the one thing the guard exists to say.
Now handled explicitly: `AccessDeniedException` → **403** `Insufficient permissions`,
`AuthenticationCredentialsNotFoundException` → **401**.

#### Verified by observation, on a real image on the network

`gateway-portal-phase3:test` built with jib and run alongside the stack on :28085 — a separate
container against the same database, so the working stack was never disturbed:

| Request | Result |
| --- | --- |
| `POST /portal/vouchers`, edge secret, **no** permissions | **403** `Insufficient permissions` |
| `POST /portal/vouchers`, edge secret, `coupon:pay,coupon:receive` | **403** |
| `GET /portal/vouchers`, edge secret, no permissions | **403** |
| `GET /portal/vouchers`, edge secret, `coupon:issue` | **200** `{"items":[]…}` |
| `GET /portal/vouchers`, **`coupon:issue` but no edge secret** | **403** — forged header ignored |
| `POST /portal/vouchers`, edge secret, `coupon:issue` | **201**, voucher `31da0183…` ISSUED |

That last row matters as much as the refusals: the guard denies without breaking issuance.

### 16.4 Phase 4 — the wallet asks instead of deciding

`canTrade(permissions, merchant)` in `lib/merchant.ts` replaces `isMerchant(merchant)` as App.tsx's
gate. It stays a type predicate on `merchant`, because every screen behind it dereferences the record
immediately, and it keeps the two questions apart: **the session says what you may do, the record says
what your stall is.** Sell needs both — the permission, and the currency and validity to issue in.

`ponytail:` an **empty** permission list is read as "this deployment cannot answer yet", not as a
denial. An account-app built before the ACL resolver returns nothing at all, and failing closed there
would take Sell away from every merchant on the stack for a reason that has nothing to do with them.
The resolver is now proven (§16.6), so the branch is waiting on compose rather than on code: it goes
as soon as the DEPLOYED account-app is one built from this gateway-core. The portal's 403 is the real
boundary meanwhile, and this side was never more than affordance — nap-react's own types say so.

Also updated: `scripts/seed-farmer.mjs` sends `X-Auth-Permissions: coupon:issue`, since it *is* the
edge in its own flow and would otherwise 403 on a request that worked yesterday.

### 16.5 What is verified, and what is not

**Verified:** gateway-core 654 tests from clean; portal 104 (7 new: three on the filter's permission
parsing including the forgery case, four on the guard in a context where method security is actually
on — `PortalVoucherControllerTest` is a `@WebMvcTest` slice and would keep passing with the annotation
deleted). Wallet `tsc -b --force` clean, `vitest run` **260**. The 403/201 table above, on a running
image. Then the whole chain, end to end — §16.6.

**Still not verified:** the Vite `portal-edge-auth` middleware in a browser. Its logic was exercised
by hand (`scripts/nap-login.mjs` performs the same validate-then-forward step, and §16.6 feeds the
result to the portal), but no page has driven it.

### 16.6 The chain, end to end, without a browser (2026-08-14)

`MerchantAclService` now derives the role from the caller's kind-30078 `d=imani:merchant` record,
read through `NostrQueryPort` — the relay-backed one in account-app's own JVM, not customer-wallet's
ingest pump. `nap_acl` keeps exactly one job: **suspension**. A suspended row denies outright, because
the stall record's owner controls it and could simply republish; the row's `role` column is no longer
consulted, having been the empty table that granted nothing.

Everything unclear is a customer — no record, `active: false`, an unreadable record, an unreachable
relay, a database blip, or the stub `NostrQueryPort` that stands in when nostr is disabled. Eleven
unit tests cover those paths, and the two fail-closed ones are the regression guard for the bug this
replaced, which granted `merchant` to unknown pubkeys *and* to anything that threw.

#### Two more schema gaps, both found by running the thing

`scripts/nap-login.mjs` performs a full NAP login with a raw key and prints what the session says you
may do. Pointed at a freshly built account-app (`gateway-core-phase2:test` on :28091, same database
and relay, deployed stack untouched), it found what 654 green tests could not:

```
POST /api/v1/auth/init → 500
PSQLException: ERROR: column "client_ip" does not exist
```

Same root cause as V31: gateway-core keeps hand-copied nap DDL under `db/migration/core` and never
runs nap-jdbc's, so nap's V2 — the RFC §17.4 outstanding-challenge cap and the §13.4 failure budget —
never arrived. `countOutstanding()` runs on **every** login, so the gateway was unauthenticable.
`V32__nap_challenges_rate_limit_and_failure_budget.sql` adds `client_ip`, `failure_count` and their
two indexes, and widens the `state` CHECK to admit `failed_terminal` — without that, the third bad
signature against one challenge would be a constraint violation instead of a refusal: a 500 where the
security control was meant to be.

**The lesson is the same one twice: the tests cannot see this schema.** Both gaps compile, pass, and
boot. Only a login against the real database finds them.

#### The run

Nothing hand-fed — the login's own `X-Auth-Permissions` was forwarded to the portal, exactly as
`vite.config.ts`'s middleware does:

| Caller | `/auth/validate` → `X-Auth-Permissions` | `POST /portal/vouchers` |
| --- | --- | --- |
| key with **no** stall record | `coupon:receive,coupon:pay` | **403** `Insufficient permissions` |
| same key, after publishing `active: true` | `coupon:receive,coupon:redeem,coupon:pay,coupon:issue` | **201**, voucher `6daa09dd…` |
| same key, after publishing `active: false` | `coupon:receive,coupon:pay` | **403** |

The middle row is the plan's end-to-end check, and the third is the one worth keeping: **closing a
stall took issuance away on the next login**, with the probe container's cache already holding the
open copy. That is the addressable-kind relay read and the newest-wins ordering, both observed rather
than argued.

The probe container also started with an **empty** nostrdb, so the merchant role was resolved from the
relay on a cold cache — the case §16.2 was worried about.

#### What is left

- The Vite middleware in a browser, which is now the only unexercised link.
- Deploying it: `deploy/compose.override.yml` already carries the two env vars a rebuilt account-app
  needs (§ the `GATEWAY_DEV_MODE` / `GATEWAY_CORE_NOSTR_*` block), and V31 + V32 are applied to
  `imani_core`, so the remaining step is pointing compose at images built from these trees.
- `aclRefreshInterval` decides how long after opening a stall a live session waits for issuance;
  a fresh login is immediate, which is what the runs above measured.

### 16.7 Deployed, and verified in a browser (2026-08-14)

`deploy/compose.override.yml` now pins **`imani-gateway-core:acl-local`** and
**`imani-gateway-portal:acl-local`**, built from the working trees with jib. Deliberately new
image NAMES rather than rebuilds of the registry tags, so `…/gateway-core:latest` stays whatever was
pulled and cannot be mistaken for this. What the registry images are missing is not cosmetic: one has
no authorization at all, the other resolves no roles, so the pair only works together.

One wrinkle, now fixed in `up.sh` rather than documented as a workaround: the portal
`depends_on: customer-wallet: service_healthy`, and customer-wallet reports `unhealthy` even when it
is working perfectly (§15.5). Compose believed it, refused to start the portal, and exited 1 — so a
plain `./deploy/up.sh` brought up eleven services, silently skipped the merchant tier, and reported
failure for a stack that was fine. `up.sh` now starts the portal separately with `--no-deps`, which
skips the dependency *start*, not the dependency: customer-wallet is still in `SERVICES` and is
already up by that line.

#### The deployed stack, before touching a browser

| Caller | `/auth/validate` → `X-Auth-Permissions` | `POST /portal/vouchers` |
| --- | --- | --- |
| key with no stall record | `coupon:receive,coupon:pay` | **403** |
| key with `active: true` | all four | **201**, voucher `afe425ea…` |

#### In the browser

`npx vite --port 5199`, driven headless (`GSTACK_CHROMIUM_NO_SANDBOX=1` — this box's AppArmor blocks
Chromium's sandbox).

- **Merchant** (`nsec` for the reopened stall) → the till: "Coupon till", Sell / Redeem, Stats in the
  account menu. Asked the page what its own session says, rather than trusting the screen:
  `fetch('/api/v1/auth/validate')` → `200 | coupon:redeem,coupon:pay,coupon:issue,coupon:receive`.
- **A real Sell**, €3.50 to the demo customer, through the UI. This is the first exercise of Vite's
  `portal-edge-auth` middleware by an actual page: it stripped the inbound headers, validated the
  session cookie against account-app, injected pubkey and permissions, and the portal's
  `@PreAuthorize` let it through. Verified away from the success screen — one kind-1059 gift wrap
  addressed to the customer appeared on strfry at the matching second (`c90d074eee4c4bf5`), and the
  same id came back from customer-wallet's nostrdb.
- **Customer** (a key with no stall record) → "Coupon wallet", Pay / Receive, no Stats row. Session:
  `200 | coupon:receive,coupon:pay`. Typing `/sell` lands on the customer home.
- **The sale survived a wipe.** Logging back in as the merchant on a fresh device state — new
  passphrase, only the nsec — restored the till from the relay, and `/merchant/transactions` reads
  **"Issued · Aug 14, 2026 · browser verification · −€3.50"** beside the received rows. §15.12's
  ledger, working on the deployed images.

**The empty-permissions shim is gone.** `canTrade` now requires `coupon:issue` outright: the
deployment answers the question, so treating silence as consent had nothing left to protect.

#### One detour, and it was the known one

The customer's wallet showed "No coupons yet" while dm-poll logged `Fetched 0 gift wrap events` and
the same query by curl returned five — §15.5 exactly. `docker restart customer-wallet-test` fixed it
and the coupons rendered. What followed is worth recording separately: the replayed backlog hit
customer-wallet's own `path_rate_limit_exceeded … /api/v1/wallet/receive limit=10/min`, so a demo
account with months of seeded coupons redeems them a few per minute. Not a defect, but it makes
"the coupon has not arrived yet" and "the coupon is never arriving" look identical for several
minutes after a restart.

### 16.8 Code review, and the hole it found in production (2026-08-14)

An adversarial review of §16 across all three repos. Most of it held; three things did not, and the
first was serious.

#### The production edge never got the memo

`NapProxyAuthFilter`'s javadoc states, as an OPS REQUIREMENT, that the edge must strip inbound
`X-Auth-Permissions` exactly as it strips `X-Auth-Pubkey`. **The only edge implementation in these
repos did neither.** `imani-deploy/nginx/conf.d/lua/nap_auth.lua` cleared `X-Auth-Pubkey` and
`X-Edge-Auth` and nothing else, and `/api/v1/portal/` routes through it. So on staging and prod:

- **Forgeable.** Any caller with an ordinary session could send `X-Auth-Permissions: coupon:issue`;
  nginx forwarded it untouched and stamped a valid `X-Edge-Auth` beside it. The portal, correctly
  trusting its edge, granted the authority. One curl header bypassed the entire kind-30078 role
  derivation. **This was introduced by §16.3** — the header meant nothing before it.
- **Simultaneously broken.** The same file never read `X-Auth-Permissions` off the validate
  response, so a real merchant arrived with no authorities at all and every portal call 403'd.

Fail-open for attackers and fail-closed for users, from one omission, and invisible in dev because
Vite's middleware implemented both halves. Fixed: the lua now clears the header inbound and
propagates it from the validate response, with the reasoning written where the next person will
read it.

**Deployment order matters.** The portal now demands `coupon:issue` on every merchant surface, and
only the edge can supply it. Ship `nap_auth.lua` **before or with** the portal image, or the merchant
dashboard 403s.

#### Permissions were frozen at login

`/api/v1/auth/validate` read `record.permissions()` off the stored session. `NapSessionFilter`
refreshes the ACL into an in-memory copy (`record.withAcl(...)`) and never writes it back, and the
only store write on that path is `touch`, which carries no permissions. So the header was whatever
the resolver said at login: **opening a stall mid-session bought nothing until the session aged out —
up to the 12-hour absolute cap — and closing one kept `coupon:issue` alive for just as long.** The
design's claim that closing a stall takes issuance away with no operator step in between was, on this
path, false.

The controller now resolves through the `AclResolver` per call, and `MerchantAclService` caches its
decision for 60 seconds. The cache is not an optimisation: `validate` is an edge subrequest on
**every** platform request and `NapSessionFilter` calls `resolve()` inline on the servlet thread, so
without it one slow (not dead) relay parks a Tomcat worker per request until the pool is gone — and
the outage is not "merchants cannot sell", it is "nobody can authenticate anything".
`suspend()` evicts immediately, because a kill-switch that takes a minute is not one.

Verified on the deployed images, one session throughout, no re-login:

```
same session, stall open     : 200 "coupon:receive,coupon:redeem,coupon:pay,coupon:issue"
same session, stall closed   : 200 "coupon:receive,coupon:pay"
same session, stall reopened : 200 "coupon:receive,coupon:redeem,coupon:pay,coupon:issue"
```

#### One guarded controller implied eight guarded controllers

`PortalVoucherController` was annotated; `PortalDashboardController`, `PortalCampaignController`,
`PortalCashbackController`, `PortalSseController` and `PolicyController` were not — all reachable by
any authenticated caller, all merchant surfaces. That is pre-existing (the portal had no
authorization at all), but guarding one class and leaving its neighbours open is worse than guarding
none, because it reads as coverage. All five now carry the same class-level guard through a shared
`PortalPermissions.MERCHANT_ONLY` constant, and **`PortalControllerGuardSweepTest` fails the build**
if a controller appears on a merchant path without one — with an explicit allowlist for the two that
are genuinely public (`PublicCashbackController`, `CashbackByCodeController`, where the claim ref IS
the capability). `PortalSseController.streamEvents` carries a documented `permitAll()` override: its
`stream_token` is the capability, because `EventSource` cannot send headers.

#### Also closed

- **The dev edge had the same shape of hole, latent.** Connect matches its mount on the parsed,
  case-insensitive pathname with a `/` or `.` boundary; Vite's proxy matches the raw url with a bare
  `startsWith`. Every path where they disagree — `/api/v1/portalfoo` — was proxied WITHOUT being
  stripped, and the proxy would then attach the secret to whatever the page sent. No such route
  exists today. The middleware now mounts at the root and filters with the *same* predicate the proxy
  uses, so the two cannot drift. `scripts/edge-forgery-check.mjs` is the runnable check: it holds a
  real customer session and tries four forgeries, all of which must 403.
- `X-Edge-Auth` is now stripped from inbound requests in dev too, not just the identity headers.
- The validate fetch has a 5s deadline; without one an account-app that accepts and never answers
  hung every Sell behind a spinner.
- A denied ACL decision (a suspended pubkey) makes `/auth/validate` answer **403**, so the edge treats
  it as unauthenticated rather than as a session with fewer powers.
- `deploy/up.sh` now fails with the exact `jib:dockerBuild` command when a locally-built image is
  missing, instead of compose reporting "pull access denied" for an image that was never in a
  registry.

#### Not fixed, deliberately

- **`imani-wallet` is not a git repository.** `vite.config.ts` is the only correct strip-then-inject
  implementation outside the nginx lua, and it has no history, no diff, no revert. This is the
  repo's setup, not something to change unasked.
- **`DevVoucherController.mockpay`** settles a voucher without payment and is unguarded. It is
  gated on mock-payment being enabled and is also mapped under `/api/v1/wallet/vouchers`, which the
  wallet tier may call — guarding it on `coupon:issue` could break a customer path. Pre-existing,
  out of scope here, worth a card.

## 17. A local media server, and Selling stops being a customer's business (2026-08-14)

Three requests, one of which turned out to be four.

### 17.1 Blossom, on this machine

`BLOSSOM_SERVER_URL` pointed at `https://blossom.primal.net`. The gateway does not proxy uploads —
it only NAMES the server through `GET /api/v1/config`, and the browser PUTs straight there — so every
avatar uploaded from a local dev session left the machine for a public host, permanently: a Blossom
blob is addressed by its own hash, and there is no delete-mine. Test avatars are still someone's face.

Now `blossom` (`ghcr.io/hzrd149/blossom-server`) runs in the stack on **:28089**, with
`BLOSSOM_SERVER_URL` defaulting to it and overridable:

```
BLOSSOM_SERVER_URL=https://blossom.primal.net ./deploy/up.sh
```

**The port is published on purpose.** The value is consumed by a browser, so an internal name like
`http://blossom:3000` would be correct-looking in the compose file and fail in the page with an
opaque network error. For the same reason `publicDomain` is left empty in `deploy/blossom.yml`: the
server then derives blob URLs from the Host header, which is exactly the address the browser used.

`deploy/blossom.yml` exists for two settings the defaults get wrong for this app:

- **Image retention.** The default is "1 month", measured from LAST ACCESS, not upload. A profile
  picture nobody views for a month is pruned and every screen showing it breaks. Avatars are not a
  cache, they are the profile — so `100 years`, this server's way of spelling "never".
- **`media.enabled`.** Off by default, and **the wallet uploads through `PUT /media`** (BUD-05,
  which strips EXIF and re-encodes server-side), not `PUT /upload`. Left off, every avatar upload
  fails with `403 Media endpoint is disabled on this server` from a server that is otherwise
  perfectly healthy: `/upload` answers, the landing page renders, the blob store works. Only a real
  client finds this, which is why the browser run mattered.

### 17.2 The wallet could not use it: `https://` was required

`@imani/blossom-upload` rejected the URL outright — `Blossom server URL must start with "https://"`.
So a local server was unusable by construction, and that constraint is what had pushed development
onto a public host in the first place.

The package now makes **the same carve-out the web platform makes**: `http://` is accepted when the
host is loopback (`localhost`, `127.0.0.1`, `[::1]`), because `http://localhost` is a Secure Context —
nothing is on the wire to intercept. Everything else still requires TLS. Matching is on the PARSED
hostname, not a prefix, so `http://localhost.evil.com` stays rejected; both halves are tested.

This is a shared package — `possa-merchant` uses it too — and the change only widens what is
accepted, never narrows it.

### 17.3 Verified in the browser, not by curl

The first three attempts each failed differently, and each failure was invisible to a shell probe:
`https://` required → `/media` disabled → an invalid test PNG (`vipspng: libpng read error`, my
fixture, not the stack). The fourth worked, and the page now shows

```
http://localhost:28089/2407624dfa4b77ef9edf4053b2e55d72cc4a71349c85a98be75e9fdec22811c4.webp
```

— uploaded from the profile screen, re-encoded to webp by the server, stored on the local volume,
fetched back with a 200 in the server log. `scripts/blossom-check.mjs` is the headless version, and
its own comment says what it does NOT cover: it uses `/upload`, so it passes even when `/media` is
off.

### 17.4 Selling is not offered to customers

Settings rendered its selling section for everyone; the only thing the merchant flag changed was the
label — "Start selling" for a customer, "Your stall" for a merchant. So a customer was invited into a
form whose every field (issuance currency, coupon validity, categories) describes a business they do
not have.

The section is now merchant-only, and `/settings/merchant` redirects to `/settings` for an account
with no stall, so typing the URL lands where the link would have.

**The predicate is the stall record's EXISTENCE, not `coupon:issue`** — deliberately. A merchant who
closes their stall loses that permission (§16.6), and this row is the way back to reopening it;
gating on the permission would lock them out of their own stall. A customer has no record at all, so
they see nothing either way. Becoming a merchant happens at registration, via the "I am a merchant"
switch that publishes the record — this row was never the way in.

Verified in the browser on both roles: a customer's Settings ends at Backup; the merchant's carries
"Merchant → Your stall".

### 17.5 The bug that shipped with it: avatar and banner vanish on re-login

Reported straight after §17: upload an avatar, save, log out, log back in with the nsec — the picture
and banner are gone. Name and about come back fine.

**Root cause, one line.** `imageUrl()` in `src/lib/branding.ts`:

```ts
return scheme === 'https:' || scheme === 'data:' ? raw : undefined
```

The local Blossom server hands out `http://localhost:28089/<hash>.webp`. That URL is fine on the way
in — it renders immediately after upload, because the component holds the upload result directly —
and `buildProfileEvent` writes it into kind-0 unsanitised. It is only on the way BACK that
`mergeKind0` runs each field through this guard, gets `undefined`, and falls back to
`profile.picture` — which on a device that logout has just wiped does not exist. So the fields are
silently dropped, and only the fields: everything non-image restores, which is exactly what makes it
read as "my photos disappeared" rather than "my profile did not load".

**This was self-inflicted, in the previous change.** §17.2 relaxed the identical https rule in
`@imani/blossom-upload` so a local server could be used at all — and left the mirror-image rule in
the reader untouched. One guard fixed, its twin missed, and the two now disagreed about the same URL.

Fixed by giving `imageUrl` the same loopback carve-out, matched on the parsed hostname so
`http://localhost.evil.test` stays rejected. Four cases added to `branding.test.ts` (three loopback
forms, one lookalike); all three loopback cases failed first, for the right reason.

**The guard that hid it during verification.** After the first bad restore, the stored profile
carries `eventAt` equal to the kind-0 it was built from, and `mergeKind0` short-circuits on
`createdAt <= profile.eventAt` — correctly, since that guard is what stops a lagging cache from
reverting a fresh edit (§14.3). The consequence: a profile already broken by this bug will NOT
re-heal from the same event. It heals on the next logout+login, because logout wipes the record and
the merge then starts from `eventAt: 0` — which is the very sequence the report describes, so nobody
needs to do anything special.

**Two things checked that turned out fine**, recorded so the next person does not re-suspect them:
the gateway's kind-0 read is NOT stale here (it returned the new event, newest-first, immediately),
and logout DOES wipe correctly — all `imani-wallet*` keys gone, landing on `/onboarding`. An earlier
run that seemed to show a surviving record was a mis-clicked Log out, not a wipe failure.

Verified end to end on the deployed stack: wipe → log in with only the nsec → both fields restored in
the stored record, and both `<img>` elements report `naturalWidth > 0` on the profile screen, i.e.
actually decoded rather than merely present.

## 18. Dockerised, and wired into imani-deploy (2026-08-14)

Plan: `~/.claude/plans/delightful-drifting-lake.md`. Phases 1-3 are done; phase 5 (retirement)
deliberately is not — see the end.

### 18.1 The wallet now owns its packages

`imani-wallet` could not be built anywhere but this machine: **16 of its 17 aliases pointed
outside the repo**, and 13 more imports reached into `../imani-apps/shared/*.js` by raw relative
path. A build context rooted here could never see them.

So the 11 `@imani/*` packages and the 10 `shared/*.js` files the legacy bridge loads were copied
in — `packages/` and `shared/`, 7 MB with `node_modules` and `dist` excluded (the source
directory is 3.1 GB with them). `vite.config.ts`'s `imani()` and the `tsconfig.app.json` paths
mirror now point at `./packages`; the five nap entries are untouched, because nap is a separate
product with other consumers and stays a sibling.

**Copied, not moved.** imani-apps still imports these packages from ~50 places, several of them
*source-contract tests* that read the package files as text — a ~50-test rewrite that must not
block this. Drift in the window is one-directional and harmless: the imani-apps frontend is being
retired, so nobody writes to its copies.

Two configs break the moment `packages/` exists inside the repo, and both were caught by running
the checks rather than by reading: **vitest** starts collecting the packages' own suites (one
wants `fake-indexeddb`, not a dependency here), so `test.include` is now scoped to `src/`; and
**eslint** starts linting them, so `packages` and `shared` are in `globalIgnores`.

`/customer` is gone. It was a second prefix existing only so the dev proxy could strip it, and
reproducing that at the edge needs a capture-into-variable rewrite whose obvious form silently
drops the query string — which is exactly where dm-poll's subscription filter lives.
`branding.ts` and `dmPoll.ts` now use same-origin `/api/v1/...`, served by the `/api` rule that
already existed.

### 18.2 The image, and the two things that nearly broke it

`Dockerfile` + `.dockerignore` + `deploy/nginx.conf`: a `node:20-alpine` builder into
`nginx:alpine` on **9546** (deliberately not imani-apps' 9545, so a stale `set` during cutover
fails loudly instead of quietly hitting the new app). Two build contexts — the primary one and
`nap=../nap` — reproducing the sibling layout at `/build/{imani-wallet,nap}` so neither config
file needs a Docker-only variant to drift.

**First build failed**, and the error pointed at the wrong thing: `tsc` reporting "Cannot find
module 'react'" against `../nap` sources reads like a tsconfig problem. It was ordering. nap is an
npm **workspaces** root, so react, `@types/react` and nostr-tools are declared by the workspace
packages — installing with `packages/` absent gets the root's five devDeps and nothing else. The
copy now precedes the install.

**The second hazard did not fire, and that is the point of checking.** That same `npm ci`
reintroduces react 19.2.4 beside the wallet's 19.2.3 — the duplicate `resolve.dedupe` exists to
collapse, whose failure mode is a **blank page in a production build only**. `curl` cannot see it:
a blank page is still a 200 with a well-formed `index.html`. Driven in a browser, the built image
renders the login screen with no console errors.

Also verified on the builder stage, where `COPY . .` happens (checking the runtime stage proves
nothing): `.seed-keys.json`, `graphify-out` and `.playwright-mcp` are all absent, and
`VITE_RELAY_URL` is compiled into the bundle.

### 18.3 The edge, which is where the dev server's second job went

The Vite dev server was also the edge proxy: seven `/api` rules across three backends plus the
`portal-edge-auth` middleware. In production that is nginx, and `nginx/conf.d/wallet.staging.conf`
(and `wallet.prod.conf`) is the production half of `vite.config.ts` — if a route works in dev and
404s in staging, the difference is in those two files.

Both are **separate files mounted alongside** `imani.conf` rather than blocks inside it. nginx
loads every `conf.d/*.conf`, so this adds a host without touching the 26 KB config that serves
everything else, and — the reason it matters for prod — without changing which server block is
the implicit default. Prod mounts the same `imani.conf` whose every `server_name` is a *staging*
name, so its API traffic lands on the first block by default; forking that file would have moved
the default out from under it.

Three things the config must get right, none of them obvious:

- **`Host` must survive.** `proxy_params` already sets `proxy_set_header Host $host`, which is
  what keeps the NIP-98 `u` tag matching the URL the gateway reconstructs. This is the edge
  equivalent of `changeOrigin: false`, and "improving" it to `$proxy_host` 401s every
  authenticated call.
- **SSE needs its own exact-match location** with `proxy_buffering off`. `dmPoll.ts` opens an
  `EventSource`; buffered, the receive pipeline looks hung rather than broken.
- **Two ungated longer prefixes** — `/api/v1/portal/cashback/{public,by-code}/` — must sit beside
  the gated `/api/v1/portal/`, because nginx picks the longest prefix regardless of order and the
  claim ref IS the credential there.

### 18.4 Verified against the real edge, locally

`openresty -t` passes for both files. Better than that: because the local stack's compose service
names match the ones the edge config uses, the whole thing runs here. An openresty container with
`wallet.staging.conf` plus the wallet image, both on the stack network:

| Request (Host: wallet.staging.398ja.xyz) | Result |
| --- | --- |
| `/` and `/sell` | 200 html — SPA fallback |
| `/api/v1/config` | account-app answers |
| `POST /api/v1/nostr/query` | 200 — customer-wallet, proving the `/customer` removal |
| `POST /portal/vouchers`, forged permissions, no cookie | **401** from `nap_auth.lua` |
| merchant session, honest | **201**, voucher issued |
| customer session, honest | **403** |
| customer session + forged `X-Auth-Permissions` | **403** |
| customer session + forged permissions **and the real edge secret** | **403** |

The last row is the one worth keeping: the lua strips client-supplied headers before it validates,
so knowing the secret buys nothing. This is the first time the permission chain has been proven
through **real nginx + nap_auth.lua** rather than through Vite's stand-in.

### 18.5 What is deliberately NOT done

**The two frontends are still deployed and still serving.** Retirement is phase 5 of the plan, and
it comes after a staging deploy and the checks above run there — because that ordering is the
rollback story: everything so far is additive, so reverting it changes nothing users touch. Once
the old hosts 301 and their services are deleted, rolling back means restarting them, which only
works while `IMANI_APPS_IMAGE` and `POSSA_MERCHANT_IMAGE` still resolve.

Two things to carry into that deploy:

- **DNS and TLS for `wallet.staging.398ja.xyz` / `wallet.imani.casa` do not exist yet**, and are
  outside this repo. Nothing is reachable until they do.
- **`lnbits-api` is built from the imani-apps repo** (`scripts/deploy-staging.sh`, a standalone
  `docker build` outside the service loop). The imani-apps *frontend* is retirable; the repo is
  not. Both scripts now carry a comment saying so.
