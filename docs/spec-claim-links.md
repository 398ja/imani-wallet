# Spec: claim links (cashback and gifts by link or QR)

**Status:** Accepted 2026-10-11. The owner decided Q1 to Q8 as recommended (section 9) at
22:00Z. Phase 0 and phase 1 are approved to build first; each phase gets its own PR, an
independent review, and owner approval before merge or deploy.
**Requested:** 2026-10-11 by the owner. Merchant cashback should be claimable by scanning a link
or QR as well as by typing the code. A customer should be able to send a voucher to someone
without an account, and a recipient with no account should be taken through registration and
then shown the voucher.
**Repos:** imani-wallet (most of the work), imani-cashback-claim, imani-gateway-portal,
imani-gateway-core, imani-gateway-customer, imani-deploy.
**Kind of document:** Diátaxis *explanation* (sections 1 to 4: why it is shaped this way) plus
*reference* (sections 5 to 8: what changes, and how we prove it). How-to guides for shoppers and
stalls follow once it ships ([customers.md](customers.md), [merchants.md](merchants.md)).

Code references are `repo:path:line` against these heads, taken on 2026-10-11:

| Prefix | Repo | Ref |
|---|---|---|
| `wallet:` | imani-wallet | `origin/main` 44e0682 |
| `claim:` | imani-cashback-claim | `origin/master` f3de940 (0.1.0) |
| `portal:` | imani-gateway-portal | `origin/main` 05deb5f |
| `customer:` | imani-gateway-customer | `origin/main` bf25f1b |
| `core:` | imani-gateway-core | `origin/main` 03a9e24 |
| `deploy:` | imani-deploy | `origin/master` 043ecf8 |

Shortened paths: `claim:…/X.java` means
`cashback-claim-rest/src/main/java/xyz/tcheeric/cashback/claim/rest/…/X.java`.
`portal:…` and `customer:…` shorten the same way under their `*-rest/src/main/java` trees.

---

## 0. Summary

1. **Most of the merchant half already exists. It is hidden, and it spends without asking.**
   The portal returns a one-time link key on generate, and the wallet throws it away
   (`wallet:src/lib/cashback.ts:251-254`). The wallet already has a `/c/:ref#k=…` landing route in
   both route trees. But it **redeems the moment a logged-in user opens it**
   (`wallet:src/pages/ClaimLandingPage.tsx:74-112`), with no prompt. So the work for cashback is:
   show the link and QR, put a confirm prompt in front of the claim, and finish the
   registration hand-off.
2. **Link design: (i), a claim reference plus a key in the URL fragment.** This is what cashback
   already uses. Section 2 compares it with (ii) a token in the fragment, (iii) a short ref
   plus a PIN, and (iv) a P2PK lock to a known npub.
3. **Customer gifts reuse the same design, but not the claim service.** The sender's wallet
   makes a fresh **link key**. It sends the coupon through the existing atomic send to the link
   key's pubkey, as if to a person. The link carries the link key's secret in the fragment.
   The gift wrap on the relay is the ciphertext, the link key is the key, and the mint's spent
   check is the single-use guarantee. No new escrow service and no new crediting redeemer.
   Section 3.1 explains why the claim service is the wrong escrow for customers.
4. **#540 stays closed.** The claim service never swaps and holds no redeemer token. A claim is
   the recipient's ordinary receive, which declares a credit only when the claimant is the
   coupon's own issuer. No link path sends a declaration header (section 3.2).
5. **Four things are broken today and can ship first.** They need no new UX (phase 0,
   section 8):
   - staging hands claims to a retired host, `CASHBACK_CLAIM_WALLET_ORIGIN` unset;
   - a device that holds a key is sent to `/onboarding` instead of `/login`;
   - the claim host has no `Cache-Control: no-store`, `Referrer-Policy` or rate limit;
   - the hosted page links to a placeholder App Store id.

---

## 1. How it works today

### 1.1 Merchant cashback: issue

1. On **Sell → Cashback** (`wallet:src/pages/CashbackIssuePage.tsx`) the merchant enters an
   amount. The issuer signs the stall's issuance warrant and calls
   `POST /api/v1/portal/cashback/generate` (`wallet:src/lib/cashback.ts:256-308`).
2. `CashbackService.generate` (`portal:…/cashback/CashbackService.java:193-405`) runs these
   steps:
   - mint the coupon through customer-wallet;
   - wait for it to finalise;
   - **make a random claim code** (`CB-XXXXX-XXXXX`, 10 characters of a 30-letter alphabet, about
     49 bits, `:1190-1222`);
   - derive the AES-256 key from the code and a random salt with PBKDF2-SHA256 at 210,000
     iterations (`:358-362`, `portal:…/cashback/TokenEncryption.java:35,56-65`);
   - encrypt the token with AES-256-GCM;
   - deposit the ciphertext and IV at the claim service (`:369`).

   The record stores the code and the salt, and never the key (`:389-402`).
3. The generate response carries `claimCode`, `claimUrl` (the claim host, no fragment) and a
   one-time `claimKey` (`portal:…/cashback/CashbackDtos.java:77-99`). The wallet keeps only the
   code. Its comment says it "deliberately drops" the key because it offers no QR path
   (`wallet:src/lib/cashback.ts:251-254`).
4. The merchant sees the code, the face value and "Must be redeemed by …", plus a Copy button
   (`wallet:src/pages/CashbackIssuePage.tsx:208-275`). The claim window comes from the
   deployment's `cashback_expiry_days`. The wallet default is 5 days (`wallet:src/lib/config.ts:75`).
   The portal clamps it to 1..90 with a default of 30
   (`portal:…/cashback/CashbackService.java:75-78,1129-1131`).

So **the code encodes nothing**. It is a random secret. The key is a function of the code and a
salt held by the portal. The claim ref is a separate 160-bit random handle
(`claim:…/service/ClaimService.java:209-214`) that only the portal and the claim service know.

### 1.2 Merchant cashback: claim by code

1. Customer: **Receive → Cashback code** (`/receive/cashback`, `wallet:src/pages/CashbackRedeemPage.tsx`)
   and type the code.
2. `redeemCashbackCode` (`wallet:src/lib/cashback.ts:894-910`) calls the public, rate-limited
   `GET /api/v1/portal/cashback/by-code/{code}`. The portal looks up the record, re-derives the key
   from the typed code and the salt, and answers `claimUrl#k=<key>`
   (`portal:…/controller/CashbackByCodeController.java:87-197`, URL built at `:190`).
3. `parseClaimUrl` (`wallet:src/lib/cashback.ts:520-546`) checks the URL. It must be `https`, on a
   host in `cashback_origins`, have a `/c/<ref>` path and a 43-character key.
4. `redeemParsedClaim` (`:952-978`) runs in this order:
   - reads the public metadata (`GET /api/v1/portal/cashback/public/{ref}`, non-destructive,
     rate-limited, `portal:…/controller/PublicCashbackController.java:85-125`);
   - calls the **destructive** `GET https://<claim host>/c/{ref}/ciphertext`
     (`wallet:src/lib/cashback.ts:620-666`);
   - decrypts with WebCrypto;
   - **stashes the token in localStorage before swapping** (`:960`, list at `:736-779`);
   - checks the mint against the trusted list (`checkTokenBacking`);
   - receives through `TokenRedemption.redeem(token, { source: 'cashback' })` (`:839-885`). That
     records the issuer-signature check and never refuses after the destructive step.

### 1.3 Merchant cashback: claim by link (exists, unexposed)

- **Hosted page.** `GET /c/{ref}` on the claim host (`claim:…/controller/PublicClaimController.java:66-72`)
  is non-destructive since ADR 0001
  ([imani-cashback-claim docs/adr/0001](https://github.com/398ja/imani-cashback-claim/blob/master/docs/adr/0001-a-claim-is-redeemed-by-the-wallet.md)).
  Its script reads `#k=` (`:216`) and offers "Add to my wallet". That button links to
  `<wallet-origin>/c/{ref}#k=…` (`:226`). It also shows Install buttons; the iPhone one points at a
  placeholder id `id000000000` (`:190-191`).
- **The wallet origin is configuration.** `cashback.claim.wallet-origin` defaults to
  `https://customer.imani.casa` (`claim:cashback-claim-rest/src/main/resources/application.yml:43`).
  **Staging does not set it** (`deploy:docker-compose.staging.yml:2008` sets only the public
  host), and `customer.staging.398ja.xyz` is a retired host that answers 404
  (`deploy:nginx/conf.d/api.staging.conf:80`). Today the hand-off button on staging leads nowhere.
- **The wallet's landing route** `/c/:ref` is in both trees
  (`wallet:src/App.tsx:502,507` authed, `:772` public).
  - **Logged in:** `redeemClaimRef` straight away (`wallet:src/pages/ClaimLandingPage.tsx:98`). It
    rebuilds the ciphertext URL from `cashback_origins[0]`, never from the link
    (`wallet:src/lib/cashback.ts:925-943`).
  - **Logged out:** park `{ref, key, at}` in localStorage under `imani-wallet:pending-claim`
    (24 h, consumed on read, `wallet:src/lib/pendingClaim.ts:32-122`), then navigate to
    `/onboarding` (`ClaimLandingPage.tsx:79-83`). After registration, `/` sees the parked claim
    and redirects to `/c` (`wallet:src/App.tsx:408`), which redeems it.
  - **A failed redeem** re-parks the key so a retry can find it (`ClaimLandingPage.tsx:104-109`).

### 1.4 The claim service

| Concern | Today |
|---|---|
| Deposit | `POST /v1/deposit`, bearer token, portal only (`claim:…/controller/ClaimController.java:25`, filter `claim:…/config/BearerTokenAuthFilter.java:32`). Idempotent on (issuer, idempotency key). Expiry at most 365 days (`claim:…/service/ClaimService.java:35,55-93`). |
| Size cap | Ciphertext at most 256 KiB (`claim:…/dto/ClaimDtos.java:23-35`). A warranted 8-proof terminal cashback measured 73k. |
| Single use | `UPDATE … SET status='claimed' WHERE status='pending' AND expires_at > now` (`claim:…/persistence/ClaimRecordRepository.java:24-30`). One winner; the loser gets `410 claimed`. |
| Revoke | `POST /v1/claim/{ref}/revoke`, atomic `pending → revoked`. A claimed claim answers `409 ALREADY_CLAIMED` (`ClaimService.java:112-124`). |
| Burn | Revoke and expiry hand the portal the ciphertext (`GET /v1/claim/{ref}/burn-material`, closed claims only, `:136-146`). The portal burns the voucher by swap through customer-wallet and acknowledges with `DELETE …/burn-material` (`:158-165`). Nothing is refunded to the merchant ([portal docs/cashback.md](https://github.com/398ja/imani-gateway-portal/blob/main/docs/cashback.md) "Burning a voucher"). |
| Retention (V4 scrub) | Claimed: ciphertext kept 7 days for operator re-serve, then nulled. Revoked or expired: kept until the burn is acknowledged, or 30 days (`claim:…/resources/db/migration/V4__scrub_terminal_ciphertext.sql`). |
| Notify | A transactional outbox posts `claimed` to the portal (`claim:…/notify/*`). |
| Public surface | `GET /c/{ref}` (page) and `GET /c/{ref}/ciphertext` (destructive, CORS `*`, no credentials). |

The claim service never sees the key, because it lives in the fragment. It never swaps, and it
holds no mint or redeemer credential.

### 1.5 Customer send

- **Send** (`wallet:src/pages/SendPage.tsx`) needs a **recipient pubkey**: scanned, pasted, or a
  NIP-05 handle resolved by `toRecipientPubkey`.
- `sendVouchers` (`wallet:src/lib/pay.ts:1375-1412`) does the following:
  - refuses a send to yourself (`:1404`);
  - refuses a third-party coupon to a merchant (`refuseIfWrongMerchant`, `:1444-1462`);
  - refuses a second send to someone whose first is unconfirmed (`:854-867`);
  - drives gateway-core's escrowed atomic send, `POST /api/v1/atomic-send`. That saga splits the
    coupon at the mint, keeps the send token **server-side**, and publishes it to the recipient
    as a NIP-17 / NIP-59 gift wrap.
- The sender then publishes a second gift wrap carrying its transfer signature
  ([ADR 0014](adr/0014-a-customer-transfer-is-signed-by-both-parties.md)).
- **Receive** is dm-poll. It reads gift wraps through the gateway's nostrdb, unwraps them
  client-side, and calls `TokenRedemption.redeem`. That reaches gateway-customer's
  `POST /api/v1/wallet/receive`.
- **Declarations on receive (#540).** A receive declares a credit to the mint's cap only when
  the caller is the coupon's verified issuer, that is, the stall taking its own coupon home
  (`customer:…/redemption/RedemptionDeclarations.java:25-35,82`). gateway-core declares only for a
  send that pays a payment request (`core:gateway-core-rest/src/main/java/xyz/tcheeric/gateway/core/atomic/service/AtomicSendService.java:679-686`).
- **A recipient with no account cannot be sent to.** There is no pubkey to name. A send to a
  pubkey that nobody will ever hold is effectively lost. The sender cannot get it back:
  reclaim on this stack answers "not yet available" (`wallet:src/lib/pay.ts:247-256`).
- `POST /api/v1/dm/tokens/send` on gateway-customer (`customer:…/rest/controller/TokenDmController.java:139`)
  is the issuer's forward of a voucher. Its pull-and-claim siblings are deprecated (`:264`).

### 1.6 Onboarding and login

- `OnboardingPage` is one route with its steps in history state:
  `start | account | profile | merchant | import` (`wallet:src/pages/OnboardingPage.tsx:52-62`).
  - **Start** offers Register, Log in, Unlock, Restore and Terminal (`:73-129`).
  - **`CreateForm`** registers a handle and passphrase, then the optional merchant profile (`:151-460`).
  - **`ImportForm`** takes an nsec (`:488`).
  - `register()` stashes the backup key and logs in. The authed app then shows the backup
    screen first (`wallet:src/App.tsx:366`).
- **`Entry`** sends a device with a stored key to `/login` (a terminal to its till) and anyone
  else to `/onboarding` (`wallet:src/App.tsx:835-857`).
- **`PublicRoutes`** drops deep links on purpose. The exceptions are `/c/:ref` and a few public
  pages (`:757-803`).

**How a link survives registration today.**
1. The fragment is read once, during render.
2. `{ref, key}` is parked in localStorage.
3. `navigate('/onboarding', { replace: true })` drops the fragment from the address bar and from
   the history entry.
4. After login, `/` peeks the parked claim and redirects to `/c`.

localStorage rather than sessionStorage is deliberate: installing an app means coming back in a
new tab (`wallet:src/lib/pendingClaim.ts:11-27`).

### 1.7 Scan

`ScanPage` routes three shapes (`wallet:src/pages/ScanPage.tsx:50-81`):
- a NUT-18V payment request, including the `cashu:` URI form, through imani-qr's
  `PaymentRequestHandler`;
- a `voucher:<uuid>` pass barcode, which is an **identifier, not value**, sent to the merchant's
  record;
- an address.

A claim URL, or a bare `cashuB…` token, falls through to "not a payment request, a voucher, or
an account".

### 1.8 Relevant NUTs

- **NUT-00** serialises a token as `cashuB<base64url CBOR>`, optionally prefixed with `cashu:` to
  make it clickable ([00.md](https://github.com/cashubtc/nuts/blob/main/00.md), "Serialization of
  tokens"). It is the standard bearer hand-off, and the basis of design (ii).
- **NUT-16** uses animated QR codes for tokens too large for one static code. Large means more
  than about 2 proofs, or long secrets ([16.md](https://github.com/cashubtc/nuts/blob/main/16.md)).
  A warranted voucher carries about 2.4k per proof in its secret, so (ii) does not fit one QR.
- **NUT-18** payment requests run the other way: the payee asks, with a transport such as
  `nostr` or `post` ([18.md](https://github.com/cashubtc/nuts/blob/main/18.md)). A recipient with no
  wallet cannot make one, so NUT-18 does not solve "send to someone without an account". It is
  how a recipient with an account could ask by link (journey D reversed), which is out of scope.
- **NUT-11** P2PK, and **NUT-28** P2BK (P2PK with a blinded receiver key), bind a token to a key.
  They are the basis of design (iv). They need a recipient key, which is exactly what journeys
  B and C do not have.

### 1.9 Security constraints already in force

| Constraint | What it means here |
|---|---|
| **cashu-mint#540** redemption cap | Crediting redeemers declare `X-Cashu-Voucher-Redemption` / `X-Cashu-Voucher-Redeemer` on their swap. Only gateway-core (payment-request splits) and gateway-customer (a stall's home-coming receive) do. wallet-api and the wallet declare nothing ([imani-deploy runbook](https://github.com/398ja/imani-deploy/blob/master/docs/runbooks/voucher-redemption-cap.md), table at line 21). The claim service is not a redeemer and must never become one. |
| **D9** | The wallet never sends a declaration header. "Swap back to sats" is a wallet-side swap that credits nobody (`wallet:src/lib/swapBack.ts:29-38`), pinned by the D9 guard tests. The wallet must not become an undeclared crediting redeemer. |
| **Edge header stripping** | `more_clear_input_headers X-Cashu-Voucher-Redeemer X-Cashu-Voucher-Redemption` at http level (`deploy:nginx/conf.d/imani.conf:9`), so no client can relay a redeemer token through the edge. |
| **Terminal credentials and licences are not money** | A licence is filtered out of balances (`wallet:src/lib/licences.ts:121`, `wallet:src/lib/merchants.ts:357`). imani-wallet#236 (open) makes the same true of terminal credentials. Neither may ever travel by claim link or be credited from one. |
| **cashu-mint#545** | Open and confidential. Orthogonal: nothing in this design depends on it or mitigates it. The "verified" mark on the confirm prompt (section 4.3) means the issuer signature and trusted mint check passed, nothing more. Its details stay in the confidential issue. |

---

## 2. The link format and its security

### 2.1 What a link must do

A claim link is a **bearer secret of bounded value**: whoever confirms first gets the voucher.
It must:

1. never let a server, a log, a proxy or a link-preview bot obtain enough to claim;
2. never spend on open: a claim needs an explicit tap by someone with a wallet to hold the
   result (ADR 0001 in imani-cashback-claim);
3. survive registration;
4. fit a static QR that a phone camera reads across a counter;
5. be revocable by whoever funded it until it is claimed, and give a single winner under a race.

### 2.2 The four designs

| | (i) ref + key in fragment | (ii) token in fragment (NUT-00) | (iii) short ref + PIN | (iv) P2PK-bound to a known npub |
|---|---|---|---|---|
| Server learns enough to claim | No (key is client-only) | No | Yes: the server must check the PIN, so it holds what opens the token. Today's code flow is this shape, with the portal re-deriving the key (section 1.2). | No |
| Link-preview bot can spend | No: the fragment is never fetched, and the claim needs a tap | No | No | No |
| QR size | Small: about 100 characters | **Too big**: a warranted voucher is 10 to 70 KB (`claim:…/dto/ClaimDtos.java:26-33`), so NUT-16 animated QR at best, and chat apps truncate | Smallest | Small |
| Single winner | Claim service atomic update, then the mint | Only the mint. Anyone who saw the link holds the token outright, forever. | Server | Mint plus lock |
| Revocable by the funder | Yes, while pending (revoke, then burn) | Only by racing the recipient at the mint, and the funder must have kept a copy | Yes | Yes, with a refund-path lock (NUT-11 `refund` plus `locktime`) |
| Recipient with no account | Yes | Yes | Yes | **No**: there is no npub to bind to (journeys B and C) |
| Leaked screenshot | Spendable until claimed or revoked | Spendable until spent | Needs the PIN too (two channels) | Useless to anyone but the bound key |
| Already built | Yes, for cashback | No | Yes (the code) | Locked vouchers exist for terminals (ADR 0005) |

**Recommendation: (i).**
- It is the only design that meets all five requirements for a recipient with no account. Most
  of it is already built and has been through review (ADR 0001, imani-gateway-portal#62 and #66).
- (iii) stays as **the code**, for paper and for reading aloud. Its server-side derivation is
  acceptable because by-code is rate-limited, and the code is about 49 bits
  (`portal:…/controller/CashbackByCodeController.java:108-126`).
- (iv) is not needed for journey D. Sending to a known npub already binds through NIP-17 and
  the gateway. It does not fit A to C at all.
- (ii) is rejected for size and for "anyone who ever saw it holds it".

### 2.3 Link formats

Both kinds open the **wallet origin** directly (`https://wallet.imani.casa`, staging
`https://wallet.staging.398ja.xyz`), not the claim host. There are three reasons.
- One hop fewer.
- One domain for a person to learn to trust, which matters for phishing (section 2.4).
- The wallet-origin misconfiguration in section 1.3 can no longer strand anyone.

The claim host's `/c/{ref}` page stays, for links and receipts already printed.

```
Cashback  https://<wallet-origin>/c/<claimRef>#k=<key>
Gift      https://<wallet-origin>/g#v=1&k=<linkSecret>&x=<expiresAtUnix>
```

- **Cashback.** `claimRef` matches `[A-Za-z0-9_-]{8,64}`. `key` is the 43-character base64url
  AES-256 key the portal already returns as `claimKey`. This is byte-for-byte the hand-off format
  the wallet already parses (`wallet:src/lib/cashback.ts:84-93`), so old and new links land on
  the same screen.
- **Gift.** `linkSecret` is the 32-byte secp256k1 secret of a fresh **link key**, base64url (43
  characters). Its pubkey is derived from it, so the path carries nothing.
  - `x` is the expiry the sender chose. The recipient's wallet shows it and refuses a claim past
    it. It is advisory, because a bearer link cannot enforce an expiry: the sender's reclaim and
    a late claim race at the mint. Tampering with `x` only misleads the person tampering.
  - `v` versions the fragment.
- **No secret ever appears in a path or a query string.** Only in the fragment, which is not
  sent in requests and never appears in `Referer`.

### 2.4 Threat model

| Threat | What happens | Control |
|---|---|---|
| **Link-preview bots and unfurlers** (Slack, WhatsApp, iMessage, Signal, email scanners) | They GET the URL without the fragment and receive the SPA shell. A bot that runs JS has no session, so it takes the public route, parks in its own storage and stops on the registration screen. | The fragment never reaches a server. **Nothing is spent without a tap on "Add to wallet"** (section 4.3), including for a logged-in browser that prerenders or prefetches. Today's auto-redeem (`ClaimLandingPage.tsx:74-112`) is removed. |
| **Server and proxy logs, analytics** | Paths log `/c/<ref>` (no key) and `/g` (nothing). The wallet ships no analytics or error-reporting SDK (checked: no Sentry, Plausible, PostHog or gtag in `src/`). | Rule: **never log `location.hash`** and never put the key in router state that is logged. Tests grep for it (section 7). Refs are logged truncated to 8 characters, as today. |
| **Referrer headers** | Browsers never send the fragment. They do send the path cross-origin, as an origin only under the default `strict-origin-when-cross-origin`. | Add `Referrer-Policy: no-referrer` on `/c/*` and `/g` at the wallet origin and on the claim host (new, imani-deploy). Neither sets one today. |
| **Browser history** | The fragment is in the entry the user opened. | Read once, then `history.replaceState` to the bare path before any await, parked or not. Today this happens only after a successful redeem (`ClaimLandingPage.tsx:103`). |
| **Screenshots and forwarded chats** | A screenshot of the QR or link is the voucher until it is claimed. | Inherent to a bearer link. Mitigated by a short claim window, revoke or reclaim by the funder, and copy that says so ("Anyone with this link can claim it"). |
| **QR shoulder-surfing at the counter** | A bystander scans the merchant's screen first. | QR shown behind a "Show QR" tap. The merchant screen polls status and swaps the QR for "Claimed" once taken. Revoke is one tap away. The code stays the low-visibility option. |
| **Race and double claim** | Two devices tap Add at once. | Cashback: the claim service's conditional update has one winner, and the loser gets `410 claimed` (`ClaimRecordRepository.java:24-30`). Gift: the mint's spent check has one winner, and the loser's receive fails with "already spent", shown as "already claimed". Same device: the `started` ref guard. |
| **Phishing lookalike domains** | `wallet-imani.casa/c/…` asks for your nsec or passphrase. | The claim path never asks for a key: it shows either the prompt or registration. The wallet derives every server URL from configuration, never from the link (`cashback.ts:933-936`), so a real wallet cannot be pointed at a fake claim host. The prompt shows the wallet's own origin. Customer docs say: "a voucher link never asks for your key". |
| **Revoke or refund by the funder** | Merchant revokes cashback; sender takes back a gift. | Cashback: the existing revoke-then-burn. The burn returns nothing to the merchant (section 3.1). Gift: the sender's wallet claims its own link (section 3.3). |
| **Expiry** | Unclaimed past its window. | Cashback: the claim service refuses after `expires_at` and the portal sweep revokes and burns. Gift: the recipient's wallet refuses past `x`, and the sender's wallet reclaims after `x` the next time it runs. |
| **Sender's device dies before the claim** | | Cashback: nothing is lost. The ciphertext is at the claim service, the code is on the merchant's row, and by-code can rebuild the link from the code on any device. Gift: the link key is derived from the sender's identity key (section 3.3), so a restored wallet re-derives its outstanding link keys and reclaims or watches them. The link itself keeps working for the recipient either way. |
| **A gift link carrying a licence or terminal credential** | It would be "money" to nobody. | The gift picker excludes licences, terminal credentials and locked vouchers. The recipient refuses to credit them (`isLicence`, #236) with "This link does not contain a voucher". |

### 2.5 Surviving the registration redirect

The fragment is client-only, so the server-side redirects that some products use (a `?next=`
parameter) would leak it. The parked-claim pattern that exists already is the right one. It gets
four changes:

1. **Park, then scrub.** On the first render of `/c/:ref` or `/g`:
   - park `{kind, ref?, key, x?, at}` under `imani-wallet:pending-claim`;
   - `replaceState` to the bare path.

   Nothing goes in a query string, in router state or in `sessionStorage`.
2. **Route by device.** Use `Entry`'s rule: a device holding a key goes to `/login`, any other
   device to `/onboarding`. Today the claim always goes to `/onboarding`
   (`ClaimLandingPage.tsx:82`), which gives a returning user a Register button when they need
   Unlock.
3. **Show the voucher on the way in.** Onboarding's start step and Login read the parked claim
   with `peekPendingClaim`, which does not consume it. They then fetch its non-secret summary:
   portal public metadata for cashback, or the decoded gift for a gift. With that they show the
   registration copy (section 4.4).
4. **Resume at the prompt, not at a spend.** After the backup screen, `/` redirects to
   `/c` or `/g` as today. That screen now shows the prompt instead of claiming.

**Storage scope.**
- localStorage is per origin and per browser.
- An installed Android PWA (a WebAPK) shares Chrome's storage, so the claim survives.
- An **iOS home-screen web app** and the **Capacitor Android app** have storage separate from the
  browser where the link was opened. The parked claim does not cross into them.

So the copy tells people to *finish here, in this browser*, and the hosted page stops pushing an
app install first. Android App Links into the Capacitor app are phase 5. Today the app has no
`VIEW` intent filter (`wallet:android/app/src/main/AndroidManifest.xml:20-23`).

The parked claim must survive a **logout** (the "different account" journey). Logout is the
one place that clears storage, so it must keep this key and the cashback token stash. That is a
test (section 7).

---

## 3. Reuse versus new

### 3.1 Cashback keeps the claim service. Gifts do not use it.

| | Merchant cashback | Customer gift |
|---|---|---|
| Who funds it | The stall. The portal mints a new coupon against the stall's issuance, gated by its warrant (portal docs/cashback.md "Issuance warrant"). | The sender's existing coupon, split by the atomic send. |
| Escrow | imani-cashback-claim: ciphertext, key in the fragment (unchanged) | The NIP-59 gift wrap to the link key, held by the relay and the gateway's nostrdb. The link secret is the key that opens it. |
| Who can revoke | The merchant, through the portal (existing `POST …/cashback/{id}/revoke`, `portal:…/cashback/CashbackService.java:1024`). **No wallet UI for it today.** | The sender, by claiming its own link |
| Never claimed | The portal sweep revokes and **burns** at expiry. Nothing returns to the merchant, because a voucher cannot be melted and issuance is a per-day ceiling. | The sender's wallet **reclaims** after `x`. The coupon returns to the sender. |
| New server state | None | None |

Why the claim service is the wrong escrow for customers:

- **Its depositor is one service.** `/v1/*` is a single bearer token, held by the portal
  (`BearerTokenAuthFilter.java:32`). Customer deposits would need a new public, NIP-98
  authenticated deposit API. That is a storage-abuse surface at up to 256 KiB a deposit, and it
  ties every gift to the sender's npub at a service that today knows no identities.
- **Its end-of-life is a burn.** Revoke and expiry hand the ciphertext to the portal to burn
  (`ClaimService.java:136-146`). A customer wants the coupon back. That would need a new
  "return to depositor" path, the depositor's identity, and a second retention rule.
- **The sender never holds the token.** The atomic send keeps the send token server-side
  (ADR 0014, "What travels"). Depositing it would need the gateway to return it to the
  client, or the gateway to deposit it, which puts the key and the ciphertext in one place.
- **The relay already gives the escrow's properties.** A gift wrap is ciphertext at rest under
  a key only the link holds. Gift wraps are already the transport, and the existing receive path
  already unwraps them.

### 3.2 #540: who declares, and why nothing new does

| Swap | Who makes it | Declares? | Why |
|---|---|---|---|
| Cashback mint | portal → customer-wallet | No | Issuance, not redemption |
| Cashback "claim" (ciphertext release) | claim service | **No swap at all** | It releases bytes. It holds no mint or redeemer credential, and must never be given one. |
| Recipient banks the cashback | gateway-customer `wallet/receive`, caller = recipient | Only if the recipient **is the issuer** (`RedemptionDeclarations.java:82`) | An honest hop otherwise |
| Gift split | gateway-core atomic send with no `paymentRequestId` | No (`AtomicSendService.java:684-686`) | Customer-to-customer hop |
| Recipient claims a gift | gateway-customer `wallet/receive`, caller = recipient | Only if the recipient is the issuer | As above. A merchant recipient that is NOT the issuer is refused (section 3.4) |
| Sender reclaims a gift | gateway-customer `wallet/receive`, caller = sender | Only if the sender is the issuer | **Prevented**: the gift picker excludes coupons the sender issued (section 4.2) |

The wallet sends no declaration header on any of these paths (D9). The edge strips both headers
from every inbound request (`imani.conf:9`).

So **claim links add no crediting redeemer and no undeclared credit**. A relabeller holding a
copied blob gains nothing new: the blob is exposed only to whoever opens the link, which is the
same exposure as today's DM or code. The mint's cap bounds what any copy can credit.

There are two edge cases, and both are refused or explained in the wallet:

- **A merchant opens its own cashback link.** The receive would declare a credit for a coupon
  that never left home. The prompt refuses: "This is your stall's own cashback. Give it to a
  customer, or cancel it."
- **A stall opens a gift of its own coupon.** That is a real redemption at the stall, so a
  declaration is correct. The prompt says so: "This is your stall's coupon. Adding it counts as
  redeemed."
- **A stall opens another stall's cashback or gift.** Refused (owner rule 2026-10-13, section 3.4).

### 3.4 A merchant takes only its own stall's vouchers (owner rule, 2026-10-13)

**Rule.** A merchant account (a key with an open or suspended stall, gateway-core's
`MerchantAclService.resolveStrict`; in the wallet, a stall record on the device or the relay) may
receive or redeem only vouchers whose signed issuer is its own stall key. Customers are unaffected.
A merchant who also shops uses a separate customer account (option A identity separation).

**Who issued it** is the signed secret's `issuer_id` (unlocked `VOUCHER`) or `issuer` tag
(`P2PK_VOUCHER`), read only when the issuer signature verifies. An unverified voucher is foreign.

**Where it is enforced.**

| Path | Server | Wallet (before anything is spent) |
|---|---|---|
| `/c/` link, cashback code | gateway-customer `wallet/receive`, 403 `FOREIGN_VOUCHER_FOR_MERCHANT` | Prompt shows the refusal instead of Add; `redeemParsedClaim` refuses before the destructive ciphertext fetch from the portal's `issuerPubkey`, and before the swap from the token (kept in the stash) |
| `/g` gift link | gateway-customer `wallet/receive` | Prompt shows the refusal instead of Add; `redeemGiftTokens` refuses before the swap |
| DM delivery, pasted token | gateway-customer `wallet/receive` | dm-poll refuses before the swap (`refuseIfAnotherStalls`, `refuseForeignForMerchant`) |
| Atomic send to a merchant | gateway-core `atomic-send`, 403 before the split | `refuseIfWrongMerchant` (existing) |
| Send by link | (as gift) | A merchant account cannot gift another stall's coupon: it could never take it back |
| Claim service `/c/{ref}/ciphertext` | **Not enforced, by design**: anonymous, releases bytes only, never swaps (ADR 0001). The swap that credits is gc's receive | Refused before the fetch |
| Raw swap at the mint | **Residual**: the mint cannot tell merchants apart. The #540 cap still never credits it (no declaration), see below | n/a |

**Fail closed, but only where a foreign voucher is seen.** An unknown standing on a foreign voucher
is refused (503 `MERCHANT_STANDING_UNAVAILABLE`, wallet: "We could not check this account just
now…", with Retry). An own voucher, plain ecash, a licence and a terminal credential are never
asked, so an outage never stops a stall's own sale.

**Exemptions.** The account's own vouchers (till Sell flow, P2PK payment to the stall, burn, take-back
of its own cashback); plain ecash; licences from a configured seller (gc
`GATEWAY_CUSTOMER_LICENCE_SELLER_PUBKEYS`, wallet `VITE_LICENCE_SELLER_PUBKEY`): not money; terminal
credentials (locked to the caller on the server): not money; the portal's cashback burn
(`burn-by-swap`, internal, the stall's own cashback).

**Residual: a raw mint swap.** A merchant's key can swap another stall's voucher at the mint
directly. Nothing on the gateway sees it. Under #540 that swap declares nothing, so it records no
redemption, attestation or ledger credit for the merchant; closing it would need the mint to require
a declared, non-merchant redeemer for every voucher swap (a cashu-mint change, not in scope).

**Residual: an unsigned receive.** gateway-customer's receive accepts an anonymous caller (a
terminal's decommission hand-back is unsigned), so a merchant who strips NIP-98 receives as nobody:
the same bearer swap as at the mint, crediting no identity and declaring nothing. Closing it needs
the hand-back signed by the terminal key, then NIP-98 required on receive (follow-up).

### 3.3 Gift links: how they work

**Send** (the sender's wallet):

1. Derive the link key.
   - `linkSecret_i = HMAC-SHA256(identitySecret, "imani-gift-link/v1/" || i)` reduced mod n.
     Retry on 0.
   - `i` is a per-wallet counter, kept locally.
   - Deterministic derivation is what lets a restored wallet find its outstanding links. An
     account whose key lives in a remote signer gets a random secret instead, stored in the
     encrypted backup.
2. Run the ordinary send flow:
   - `sendVouchers({ recipient: { pubkey: linkPub, name: 'Link' }, … })`;
   - `refuseIfWrongMerchant` passes, because a fresh key has no merchant record;
   - the atomic send splits and gift-wraps the send token to `linkPub`.

   No ADR 0014 transfer signature is sent for link sends in v1. Its `recipient` would name the
   link key, not the final holder (open question Q7).
3. On `COMPLETED`:
   - fetch and unwrap that gift wrap with `linkSecret` (check the delivery);
   - keep a `sent` row with `link: { i, x, status: 'outstanding' }`;
   - show the link and QR.

   The row holds the link secret. It is a bearer secret on the sender's own device, the same
   class of thing as the coupon it replaced.

**Claim** (the recipient's wallet; the visitor may have no account):

1. Derive `linkPub` from `k`.
2. Query kind-1059 wraps tagged `#p = linkPub` through the gateway, signing NIP-98 with the
   **link key**, never the visitor's identity.
3. Unwrap them, reassembling chunked DMs with the existing parser, and decode the token.
4. Verify it before anything is spent:
   - the issuer signature;
   - the trusted mint;
   - not a licence or terminal credential;
   - not past `x`;
   - its proofs `UNSPENT` by NUT-07 checkstate, otherwise "already claimed".
5. Show the prompt. Everything on it comes from the token itself, so for a gift the prompt is
   stronger than for cashback.
6. On **Add**, receive through `TokenRedemption.redeem(token, { source: 'gift_link' })`. This
   needs a new `source` value.

**Status and reclaim** (the sender's wallet):

- On start and on opening History, check NUT-07 for outstanding links: spent means `claimed`.
- After `x`, reclaim by receiving the token itself (`source: 'gift_link_reclaim'`), then mark
  the row `reclaimed`. "Take it back" does the same before `x`.
- A restored wallet scans `i = 0 … last + 20` for wraps to each derived `linkPub` and adopts the
  outstanding ones.

---

## 4. The wallet UX

Copy follows `CONTEXT.md` ("coupon" in code, "voucher" in user-facing copy, as the app does
today). Each screen below is new unless it says otherwise.

### 4.1 Merchant: link and QR next to the code (changes `CashbackIssuePage`)

After **Create cashback code**, the success panel keeps the code exactly as today and adds the
following:

- **Show QR**: a tap reveals a QR of `https://<wallet-origin>/c/<ref>#k=<claimKey>`. It is not
  shown by default, because of shoulder-surfing.
- **Share link**: `navigator.share` where available, otherwise **Copy link**. The note under it
  reads: *"Anyone with this link or QR can claim it once. It works until {date}."*
- **Live status.** While the screen is open, `fetchCashbackStatus` every 5 seconds. When the
  status reaches `Claimed`, swap the QR for *"Claimed just now"*. Today's screen reads it once.
- **Cancel cashback** (also on the record detail page). It calls the existing portal revoke and
  is confirmed with *"Cancel this cashback? The customer will no longer be able to claim it.
  The value is not returned to you."*
- **The record detail page** (`wallet:src/pages/RecordDetailPages.tsx:446`) gets **Show QR
  again**. It rebuilds the link through `by-code` from the code the row already stores. The key
  itself is never stored on the merchant's device.

The wallet stops dropping `claimKey` (`cashback.ts:251-254`) and returns it on `IssuedCashback`.
The "Copy code" copy changes from *"type into their wallet"* to *"scan, or type into their
wallet"* (`CashbackIssuePage.tsx:181-184`).

### 4.2 Customer: Send by link (changes `SendPage`)

1. **Send** gets a recipient option: *"Anyone, by link"*. It sits next to scanning an account.
2. The voucher picker excludes the following:
   - licences and terminal credentials;
   - locked vouchers;
   - coupons **issued by the sender** (section 3.2): *"To give away your own stall's vouchers,
     use Cashback."*
3. The amount step, plus **Link expires in** (default per Q3, choice of 1, 7 or 30 days).
4. The confirm step reads: *"Anyone with the link can claim {face} from {stall}. You can take it
   back until it is claimed."*
5. The success step shows **Show QR**, **Share link** and **Copy link**, plus the expiry.
6. History: a `sent` row with a *"By link"* badge, a status of outstanding, claimed, taken back
   or expired, and **Take it back** while it is outstanding.
7. **Limit.** At most N outstanding links per wallet (Q5). A further send is refused with
   *"You have N links waiting to be claimed. Take one back or wait for it to be claimed."*

### 4.3 Recipient: the confirm prompt (replaces the auto-redeem)

Route `/c/:ref` (cashback) and `/g` (gift), in both trees. When there is no session the prompt
is replaced by section 4.4. The prompt shows the following:

```
            [stall avatar]
   {Stall name}  ✓ verified stall
   {Face value}
   Cashback from {Stall name}          (gift: "Sent by {sender} via link")
   Claim by {claim expiry}  ·  Valid for {coupon validity} once added
   Adding to: {your handle}            Not you? Switch account

   [ Add to my wallet ]
   [ Not now ]
```

**Stall name.** Resolve the issuer pubkey's profile and merchant record with the existing
`useIdentity` / `useMerchantLabel`. If neither resolves, show *"Unknown stall"* and its short
npub.

**Issuer verification.**

| | Before the tap | After the claim |
|---|---|---|
| Cashback | The ciphertext cannot be read without spending the claim, so the prompt shows the **portal's** metadata: issuer, face, unit, expiry, status. That metadata came from a host the wallet trusts by configuration. | The coupon is checked: issuer signature (`cashbackValidation`) and mint (`checkTokenBacking`). A face or issuer that differs from the metadata is flagged on the row, never refused (the claim is already spent, `cashback.ts:839-885`). |
| Gift | Everything is checked against the token itself: issuer signature, trusted mint, NUT-07 unspent, `x`. | Not needed |

`✓ verified stall` appears only when the check passes. Otherwise the line reads
*"We could not verify this voucher"*, and Add is disabled for an untrusted mint.

**Actions.**
- **Add to my wallet** is the only action that spends. A second tap is ignored.
- **Not now** keeps the parked claim (24 h) and goes home. Nothing is told to anyone.
- **Decline** is in the overflow menu. It discards the parked claim on this device and nothing
  else: the funder can still revoke, or reclaim after expiry.
- **Switch account** keeps the parked claim and runs the existing logout, with its backup
  warning. The claim resumes after the next login.

**States shown instead of the Add button.**

| State | Copy |
|---|---|
| Already claimed (metadata `Claimed`, `410 claimed`, or proofs spent) | *"This voucher was added to a wallet on {claimedAt}. If that was you on another device, it is there."* |
| Expired | *"This voucher expired on {date}."* Gift: *"Ask {sender} to send it again."* |
| Revoked | *"{Stall} cancelled this voucher."* |
| Own cashback (merchant) | *"This is your stall's own cashback. Give it to a customer, or cancel it."* |
| Another stall's voucher (merchant account, section 3.4) | *"Merchant accounts can only take their own stall's vouchers. To use a voucher from another stall, use a customer account."* With **Switch account** (the claim stays parked). Role unknown: *"We could not check this account just now, so the voucher was not added. Nothing was spent. Try again in a moment."* with Retry |
| Not money (licence or terminal credential) | *"This link does not contain a voucher."* |
| Untrusted mint | *"This voucher is from a mint this wallet does not use."* The cashback claim is not attempted. |
| Network | *"We could not reach the voucher service. Your voucher is still waiting."* with Retry (true, because nothing was spent) |
| Broken link (no key, bad key) | *"This link is incomplete. Ask for it again, or scan the whole QR."* |
| Disabled deployment | *"This wallet cannot claim vouchers yet."* |

**After a successful claim**, the existing `Outcome` component shows *"Voucher added. {Face} from
{Stall} is in your wallet."* plus **Open my wallet**, and arrives with the `materialize` motion.
Held and refused outcomes keep today's copy (the `held` and `refused` kinds,
`cashback.ts:488-498`).

### 4.4 Registration copy (journey B)

When the start step of onboarding (or Login) finds a parked claim, it shows a voucher banner
above the buttons:

> **Create an account to redeem the voucher from {Stall name}**
> {Face value}. Claim by {date}.
> Nothing is claimed until you add it. You can do that in a minute, right here.

For a gift: *"{Sender} sent you a voucher from {Stall name}. Create an account to add it to your
wallet."*

Then:
- On `/onboarding`, **Register** is primary and "I already have an account" (Log in / Restore) is
  secondary. On `/login` it is Unlock.
- The merchant toggle stays available.
- If the summary cannot be fetched, the banner falls back to *"Create an account to redeem your
  voucher"*. It never blocks registration.

The hosted claim page on the claim host changes its lede to the same sentence. Its primary
button becomes **Continue in the browser** (the wallet hand-off). App Store and Play buttons
disappear until real listings exist (they are placeholders today, `PublicClaimController.java:190-191`).

### 4.5 Where links open

- **The wallet origin (the PWA).** Link scope is `/` (`wallet:public/manifest.json:5-6`). An
  installed Android PWA captures the link. iOS opens it in Safari.
- **Capacitor app.** No deep link today. Phase 5 adds `/.well-known/assetlinks.json` and an
  `autoVerify` intent filter for `/c/*` and `/g`. The app's `appUrlOpen` would then navigate the
  WebView to the same path and fragment.
- **Scan inside the wallet.** `ScanPage` recognises a claim URL whose host is the wallet's own
  origin or a `cashback_origins` host. It parks the claim exactly as a link open would, then
  navigates to the bare route. A bare `cashuB…` / `cashu:cashuB…` token (NUT-00) is routed to
  the same gift prompt (phase 5).

---

## 5. User journeys

### 5.1 Journey A: merchant cashback by link or QR, recipient has an account

1. Merchant: **Sell → Cashback**, enters €2.00, **Create cashback code**. The screen shows the
   code, then **Show QR** and **Share link**.
2. Customer scans with the phone camera. `https://wallet.imani.casa/c/<ref>#k=…` opens in the
   browser, or in the installed PWA.
3. The wallet parks the claim, scrubs the URL, and shows the prompt: stall, €2.00, claim-by
   date, "Adding to: @ana".
4. Customer taps **Add to my wallet**. Ciphertext fetch, decrypt, stash, trusted-mint check,
   receive. Then *"Voucher added"*.
5. Merchant's screen flips to *"Claimed just now"* within 5 s. The bell entry and push arrive
   through the existing notify path (#158).

| Variation | Result |
|---|---|
| Second device, after the claim | Prompt shows *"added to a wallet on {date}"* (metadata `Claimed`). The portal learns of a claim through the claim service's outbox, so for a second or so the metadata can still say `Unclaimed`. The tap then gets `410 claimed`, with the same copy. |
| Already-claimed link, same device | Same, from the metadata. No ciphertext call. |
| Expired | Metadata `Expired` (or `410 expired`) and the expired copy |
| Revoked | `410 revoked` and *"{Stall} cancelled this voucher"* |
| Logged in as a different account | Prompt names the account. **Switch account** keeps the parked claim through logout and login. |
| Declined | Discarded locally. The merchant can still cancel. The claim window runs out, then the sweep burns. |
| Not now | Parked 24 h, offered on the next visit to `/` |
| Merchant scans their own QR | Refused: own cashback |
| Network fails at the tap | Prompt stays, with Retry. The claim is untouched (the fetch had not succeeded) or the token is stashed (the fetch succeeded), and `replayPendingCashback` banks it. |

### 5.2 Journey B: the same, recipient has no account

1. Customer scans and opens the link. There is no session, so the public `/c/:ref` route
   parks the claim and scrubs the URL.
2. The device holds no key, so the visitor goes to `/onboarding`. The banner reads *"Create an
   account to redeem the voucher from Ana's Bakery. €2.00. Claim by 16 Oct."*
3. Register: handle and passphrase, optionally the merchant profile. Then the backup screen
   (unchanged).
4. `/` sees the parked claim and redirects to `/c`. The prompt shows. **Add to my wallet**, then
   *"Voucher added"*.

| Variation | Result |
|---|---|
| Device already holds a key (logged out) | Sent to `/login` with the same banner. Unlock, then the prompt. |
| Registration abandoned, link opened again later | Parked again (the link is still pending). Banner as before. |
| Opened on a laptop, finished on a phone | The phone claims. The laptop's parked claim later shows "already added". |
| More than 24 h between the link and finishing registration | The parked claim has expired locally. Copy: *"Open your voucher link again to add it."* The link itself still works until the claim window ends. |
| iOS: link opened in Safari, account created in the home-screen app | Storage is not shared. The copy in section 4.4 keeps people in the browser. Phase 5 fixes this for the Android app only. |

### 5.3 Journey C: customer gift to someone without an account

1. Sender: **Send → Anyone, by link**, picks a Bakery coupon, €5.00, expiry 7 days, confirms.
2. The wallet derives link key `i = 3` and runs the atomic send to `linkPub`. On `COMPLETED` it
   checks the gift wrap and shows **Show QR**, **Share link** and **Copy link**.
3. The sender shares it in a chat. The unfurler fetches `/g`, gets the shell, and claims nothing.
4. The recipient opens it with no session. `/g` parks the claim and scrubs the URL, then fetches
   and decodes the gift with the link key (no account needed). The registration banner reads
   *"Bob sent you a voucher from Ana's Bakery. Create an account to add it to your wallet."*
5. Register and back up. The prompt shows the token-verified summary. **Add to my wallet**, then
   receive.
6. The sender's history shows `claimed` on the next NUT-07 check.

| Variation | Result |
|---|---|
| Never claimed | After 7 days the sender's wallet reclaims on its next start, and the row shows `taken back` |
| Sender taps **Take it back** | Reclaims. The recipient later sees "already claimed". (The copy cannot tell a reclaim from someone else's claim without leaking which it was; Q7.) |
| Sender and recipient race | Mint picks one |
| Sender's phone lost | Restored wallet scans `i`, adopts outstanding links, and keeps reclaiming after `x` |
| Recipient opens after `x`, before the reclaim | The wallet refuses the claim, with the expired copy |

### 5.4 Journey D: gift by link to someone with an account

As C, but the recipient is logged in and goes straight to the prompt (journey A's steps 3 to 4,
with the gift summary). The confirm screen in Send suggests *"If you know their handle, send to
them directly: nobody else can claim it."* A direct send binds the voucher to the recipient
through NIP-17. A link does not.

---

## 6. API and wire changes

**NEW** marks new backend work. Everything not marked is configuration or wallet-only.

### 6.1 imani-wallet

| Change | Where |
|---|---|
| Keep `claimKey` from generate and build the wallet-origin link | `src/lib/cashback.ts` (`generateCashback`, `IssuedCashback`) |
| Link codec: `formatCashbackLink`, `formatGiftLink`, `parseClaimLink` (cashback, gift, legacy claim-host URL), strict patterns | new `src/lib/claimLink.ts` |
| Parked claim grows `kind` (`cashback` or `gift`) and `x`; logout must not clear it | `src/lib/pendingClaim.ts` and the logout path |
| `ClaimLandingPage`: no auto-redeem; parks and scrubs first; routes by device (`/login` or `/onboarding`); prompt and states | `src/pages/ClaimLandingPage.tsx` |
| `GiftLandingPage` at `/g`, both trees | new |
| Onboarding and Login voucher banner | `src/pages/OnboardingPage.tsx`, `src/pages/LoginPage.tsx` |
| Merchant: Show QR, Share, live status, Cancel, Show QR again | `src/pages/CashbackIssuePage.tsx`, `src/pages/RecordDetailPages.tsx`, new `revokeCashback` in `src/lib/cashback.ts` |
| Send by link, link-key derivation, outstanding-link tracker, reclaim, restore scan | `src/pages/SendPage.tsx`, new `src/lib/giftLink.ts` |
| Gift fetch: NIP-98 with the link key, wrap query, unwrap, chunk reassembly | reuse `src/lib/dmPoll.ts` and `src/lib/dmChunks.ts` helpers |
| New receive sources `gift_link` and `gift_link_reclaim` | `shared/tokenRedemption.js`, `packages/wallet-storage/src/types.ts:82` |
| Scan routes claim links (and NUT-00 tokens, phase 5) | `src/pages/ScanPage.tsx` |
| D9 guard extended: no declaration header on any link path | existing guard tests |

### 6.2 imani-cashback-claim

| Change | Kind |
|---|---|
| `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` on `/c/**` (the page already sets the robots meta) | **NEW**, small |
| Landing page: copy from section 4.4; hand-off button primary; remove the placeholder store links | **NEW**, small |
| A metric on the public redeem, `cashback_claim_public_redeem_total{outcome=ok,claimed,expired,revoked,not_found}`, for the dashboards in section 6.7 | **NEW**, small |
| No change to deposit, the single-use update, revoke, burn-material, retention or the 256 KiB cap | none |

### 6.3 imani-gateway-portal

| Change | Kind |
|---|---|
| None required for phases 0 to 3. `claimKey`, by-code, public metadata and revoke all exist. | none |
| Optional: `voucherValidityDays` on the public metadata, so the prompt can say "valid for N days once added" | **NEW** field, additive |

### 6.4 imani-gateway-core

| Change | Kind |
|---|---|
| None expected. Gifts are ordinary atomic sends to a pubkey. **Verify** that a `COMPLETED` send to a recipient who never acts is never auto-reclaimed by `autoReclaimAfter` (PT24H, `core:…/atomic/config/AtomicSendProperties.java:43`). That setting must apply only to stuck sagas. | verification; a fix is **NEW** if it does not |

### 6.5 imani-gateway-customer

| Change | Kind |
|---|---|
| **Verify** that `POST /api/v1/nostr/query`, NIP-98 signed by a never-seen key, returns kind-1059 wraps tagged `#p` with that key. That is what the gift fetch needs (`customer:…/rest/controller/NostrQueryController.java:32`). | verification |
| **Verify** that the push trigger on a send to a key with no subscription is a no-op, not an error | verification |

### 6.6 imani-deploy

| Change | Kind |
|---|---|
| Set `CASHBACK_CLAIM_WALLET_ORIGIN` to the wallet origin (staging `https://wallet.staging.398ja.xyz`, prod `https://wallet.imani.casa`) | config, **phase 0** |
| `limit_req` on `^/c/…/ciphertext$` and `^/c/…$` at the claim host (none today, `nginx/conf.d/api.staging.conf:41-48`), for example 30 r/min per IP with a burst of 10 | config |
| `Referrer-Policy: no-referrer` on `/c/` and `/g` at the wallet origin | config |
| nostrdb and relay retention of kind-1059 wraps of at least the longest gift expiry plus a margin. Retention is `startup` mode today (`docker-compose.staging.yml:1674`), with a window to be confirmed. | **verify, then config** |
| Phase 5: `assetlinks.json` at the wallet origin | config |

### 6.7 Abuse, rate limits, privacy, observability

**Rate limits.**
- By-code and public metadata are already limited per IP and per code (portal).
- The ciphertext endpoint is protected by its 160-bit ref, not by a limiter. The edge limit
  above caps scraping and log noise.
- Gift fetches are ordinary NIP-98 relay queries, under gateway-customer's per-pubkey limits.
  Each link key is fresh, so an edge per-IP limit is what bounds them.
- The outstanding-links cap (Q5) bounds how much one wallet can park on relays.

**Abuse.**
- Cashback issuance is already gated by the stall's warrant, one nonce per cashback. Links do
  not change what can be minted.
- A gift costs the sender their own coupon.
- A malicious link can only offer a voucher. It cannot take one. The worst it can do is show a
  real stall's name over a voucher at an untrusted mint, and the prompt refuses that.

**What each service learns.**

| Service | Learns | Does not learn |
|---|---|---|
| Claim service | Ref, time, claimant's IP (no cookies, no auth) | The key, the token, who the claimant is |
| Portal public metadata | Ref, IP | Identity (no auth) |
| Gateway, for a gift | Sender identity → `linkPub` (the send); `linkPub`'s query and its IP; the recipient's identity when they receive. The receive call carries the token, so `sent_voucher_id` links sender to recipient, **exactly as for a direct send today**. | The link secret |
| Relays | A wrap to a never-seen pubkey | Contents |

**Observability.**
- Claim service: the new redeem counter and the existing outbox metrics.
- Portal: the existing `cashback_*` meters.
- The wallet adds no telemetry.
- Logs: the ref truncated to 8 characters, never the fragment, never a token. Test-enforced.
- Alert on a spike of `cashback_claim_public_redeem_total{outcome="claimed"}` per hour. Losers
  of races, or a scraper, show up there.

---

## 7. Testing

**Unit tests (wallet, vitest).**
- `claimLink`:
  - format and parse round trip;
  - rejects a key of the wrong length, `http:`, an unknown host for the legacy claim-host form,
    and a missing fragment;
  - never reads a key from the query or the path.
- Link-key derivation: fixed vectors, and the restore scan's gap rule.
- `pendingClaim`: kinds, `x`, survives logout, 24 h expiry, consumed only by the screen that
  spends.
- `ClaimLandingPage` and `GiftLandingPage` state machines:
  - **no spend before the tap**;
  - double tap means one spend;
  - every refusal state in section 4.3;
  - scrubs the URL before the first await.
- `ScanPage` routing for claim links.
- **Fragment hygiene.** A test renders every link route with a spy on `console.*` and
  `fetch`, and asserts the key string never appears in any logged line or request URL.
- **D9.** The existing guard extended to the gift claim, the reclaim and the cashback claim.
  None sends `X-Cashu-Voucher-Redemption` or `X-Cashu-Voucher-Redeemer`.
- **Not money.** A gift containing a licence or terminal credential is refused and never
  credited.

**Integration tests.**
- Claim service MockMvc:
  - the new headers on `/c/**`;
  - the landing page still never references `/ciphertext`. This is the existing test with
    teeth (ADR 0001); keep it.
- Portal: generate returns `claimKey`, and by-code rebuilds the identical link (exists; extend
  to assert equality).
- Core and customer: run the two verifications in sections 6.4 and 6.5 as ITs.
  - A completed send to an idle key is not auto-reclaimed.
  - A NIP-98 query by a fresh key returns its own wraps.

**Gate e2e** (Playwright, two browser contexts, against staging, `E2E_PHASE=claim-links`):

| ID | Covers |
|---|---|
| CL-A | Journey A: merchant issues, recipient (logged in) opens the link, prompt, Add, balance up, merchant screen flips to Claimed |
| CL-B | Journey B: a fresh context opens the link, sees the stall-named registration banner, registers, backs up, prompt, Add |
| CL-B2 | Journey B with a stored key: the link lands on `/login` with the banner |
| CL-C | Journey C: sender sends by link, a fresh context registers and claims, sender sees `claimed` |
| CL-D | Journey D: link to a logged-in context |
| CL-BOT | `curl` the link and load it in a headless context **with no session and JS on**. Then assert: merchant status still `Unclaimed`; gift proofs still `UNSPENT`; an authed context still gets the prompt. Also: an authed context that loads the link and never taps leaves it unclaimed. |
| CL-RACE | Two authed contexts tap Add within 50 ms. Exactly one "Voucher added", one "already added". Claim service has one `claimed`. Mint has one spend. |
| CL-EXP | Cashback with the portal clock or the 1-day minimum is out of reach in a gate, so use **revoke** for the closed path, plus a claim-service IT with a past `expires_at` for expiry. Gift: `x` in the past means a refused claim, and the sender's reclaim then succeeds. |
| CL-SWITCH | Logged in as X, **Switch account**, log in as Y. The parked claim resumes on Y. |
| CL-OWN | A merchant opens its own cashback link and is refused. No declaration in gateway-customer's `voucher_redemption_receipt`. |
| CL-MERCHANT | A merchant opens ANOTHER stall's cashback link and gift link: the prompt refuses with the section 3.4 copy, nothing is spent (cashback still `Unclaimed`, gift proofs `UNSPENT`), and a customer account then adds both. A direct `wallet/receive` of a foreign token by the merchant key answers 403 `FOREIGN_VOUCHER_FOR_MERCHANT`. |

---

## 8. Phasing (tracer bullets)

### Phase 0: stop stranding people (deploy, claim, wallet; no new UX)

- Set `CASHBACK_CLAIM_WALLET_ORIGIN` in staging and prod.
- Claim host: the new headers, and the store placeholders removed.
- Wallet: the public `/c/:ref` routes by device (`/login` or `/onboarding`), and scrubs the
  fragment before any await.

Done when an old cashback link on staging reaches a working wallet screen.

### Phase 1: the confirm prompt (wallet)

- Remove the auto-redeem.
- Add the prompt and every state in section 4.3, for existing `/c/:ref` links.

Done when CL-BOT passes on today's links. **This is the security fix and should not wait for the
rest.**

### Phase 2: merchant link and QR (wallet)

- Keep `claimKey`.
- Show QR, Share link, live status, Cancel cashback, Show QR again.

Done when CL-A, CL-RACE and CL-OWN pass.

### Phase 3: registration (wallet, claim host copy)

- The banner on onboarding and login.
- The parked claim survives logout.
- The hosted page copy.

Done when CL-B, CL-B2 and CL-SWITCH pass.

**As built (wallet, phase 3 PR).**
- Parked claims are a list keyed by ref under `imani-wallet:pending-claim`, at most 5 entries, each
  `{kind, ref, key, x?, at}` with its own 24 h age (review of #239, F4-1). A second link opened while
  logged out is added, never written over the first (O4). `/` resumes the newest entry this account
  has not been shown this page session. An older build's single object reads as a list of one.
- The key is parked in plaintext localStorage, as since phase 0 and as section 2.5 requires (not
  sessionStorage: the install journey comes back in a new tab). There is no account key to wrap it
  under before registration. It is bounded instead: 24 h, five entries, removed once added,
  declined or dead. An aged-out entry is erased, not just hidden, when the banner has shown the
  aged-out copy (once) or when `/` resumes (review of #245, F1). It is never rendered, logged or sent: the banner sends only the ref.
- Logout sweeps every `imani-wallet:*` key except this one, whose live entries are carried across
  with their ages. The cashback token stash (`imani:cashback:pending`) was never swept. Nothing that
  names the logged-out account survives (CL-SWITCH checks the account's pubkey).
- **Switch account** ("Not you?") on the prompt parks the claim on screen and runs the normal logout,
  with its warning.
- The banner (`ParkedClaimBanner`) sits above Register on onboarding's start step and above Unlock
  on Login, with the same words on both (5.2). It falls back to *"Create an account to redeem your
  voucher"* when the summary cannot be fetched, and says *"Open your voucher link again to add it."*
  when the only parked claims have aged out.
- The hosted page (imani-cashback-claim) uses the fallback sentence as its lede, since it knows no
  stall name and looking one up would be server logic, and its button reads **Continue in the
  browser**.

### Phase 4: gifts (wallet; core and customer verifications)

- Run the two verifications in sections 6.4 and 6.5 first. They gate everything else here.
- Link key, Send by link, `/g`, gift prompt, outstanding tracker, reclaim, restore scan.
- Relay retention confirmed in imani-deploy.

Done when CL-C, CL-D and CL-EXP pass.

**As built (wallet, phase 4 PR).**
- Pre-checks (6.4, 6.5, 6.6) passed with no server change; gifts are wallet-only.
- `src/lib/giftLink.ts` (derivation, the link, the wrap fetch, `verifyGift`, the picker rule) and
  `src/lib/giftLinks.ts` (counter, send, status, Take it back, reclaim after `x`, restore scan).
  Send by link is its own screen (`/send/link`), reached from Send's first step.
- The link's secret is stored on the sender's `sent` row as `link: {k, i?, x, status}` and in the
  row's NIP-44 history record (`gift_link`), so a second device or a restore can show and reclaim
  it. A remote-signer account's random links are recovered from there, not by the scan.
- The wrap query has no `since`, is NIP-98 signed by the link key, and omits credentials. NUT-07 asks
  the token's mint directly with the proofs' `Y`s only, and only a mint this wallet trusts.
- The stall named on the prompt is the voucher's signed `issuerId` (the signing key is the gateway's
  for cashback-born coupons). The sender is named by kind-0 name, else handle, else short key.
- A link's status reaches **Claimed** only when every proof is SPENT; a reclaim that loses the race at
  the mint reads as Claimed. A mint that cannot answer never triggers a reclaim.
- Gate e2e `e2e/giftLinks.e2e.ts` covers CL-C, CL-D, CL-EXP and Q4 with five browser contexts.

### Phase 5: reach

- Android App Links into the Capacitor app.
- Scan routes claim links and NUT-00 tokens.
- How-to guides in [customers.md](customers.md) and [merchants.md](merchants.md).

---

## 9. Decisions (formerly open questions)

**All eight questions were DECIDED by the owner on 2026-10-11 at 22:00Z, each as recommended.**
The decision is recorded on PR #237. The wording below keeps each question and its
recommendation, which is now the decision.

| Q | Topic | Decision (2026-10-11) |
|---|---|---|
| Q1 | Link design | DECIDED: cashback by claim ref plus fragment key through the claim service; gifts over NIP-17 with a fresh fragment link key, not through the claim service |
| Q2 | Typed code | DECIDED: the typed code stays, always next to the link |
| Q3 | Default expiry | DECIDED: cashback uses `cashback_expiry_days`, set explicitly in each environment; gifts 7 days, with 1, 7 or 30 |
| Q4 | Funder takes it back | DECIDED: Cancel cashback in the wallet, Take it back for gifts; cancelled or expired cashback still burns with no refund |
| Q5 | Gift fees and limits | DECIDED: no fee, at most 10 outstanding links per wallet, no per-link cap beyond the face |
| Q6 | Merchant own coupons by link | DECIDED: no, use Cashback |
| Q7 | Recipient copy after a take-back | DECIDED: "This voucher is no longer available"; no ADR 0014 transfer signature on link sends in v1 |
| Q8 | Native app | DECIDED: phase 5; until then, finish in the browser |

1. **Q1. Link design.** DECIDED 2026-10-11 as recommended.
   - Cashback by (i), a claim ref plus a key in the fragment, through the claim service (as
     today).
   - Gifts by (i) over NIP-17, with a fresh link key in the fragment, **not** through the claim
     service.

   *Recommend: yes.* The alternative extends the claim service with NIP-98 customer deposits and
   a return-to-depositor path. That means more server state, and the claim service learns
   senders' identities (section 3.1).
2. **Q2. Does the typed code stay?** DECIDED 2026-10-11 as recommended. *Recommend: yes, always next to the link.* Paper receipts,
   reading a code aloud, and phones whose camera will not open all need it, and it costs nothing:
   the link is derived from the same secret.
3. **Q3. Default expiry.** DECIDED 2026-10-11 as recommended.
   - Cashback: keep the deployment's `cashback_expiry_days`. Note that the wallet fallback (5)
     and the portal default (30) disagree today; set it explicitly in each environment.
   - Gifts: 7 days, with a choice of 1, 7 or 30.

   *Recommend: as stated.*
4. **Q4. Can the funder take it back?** DECIDED 2026-10-11 as recommended.
   - Merchant cashback: yes, with a **Cancel cashback** button in the wallet. The portal supports
     it; the wallet has no button.
   - Gift: yes, **Take it back** until claimed, and automatically after expiry.

   *Recommend: yes to both.* Also confirm that a cancelled or expired cashback still **burns
   with no refund to the merchant** (today's portal behaviour). Changing that is a separate
   decision with ledger consequences.
5. **Q5. Fees or limits on gifts.** DECIDED 2026-10-11 as recommended. *Recommend: no fee. At most 10 outstanding links per wallet. No
   per-link cap beyond the coupon's own face.* The mint fee of the split is already paid by the
   atomic send, as for any send.
6. **Q6. Should a merchant be able to send their own coupons by link?** DECIDED 2026-10-11 as recommended. *Recommend: no, use
   Cashback.* It keeps the warrant, issuance accounting and the #540 declarations on the paths
   built for them (section 3.2).
7. **Q7. What the recipient sees when the sender takes a gift back.** DECIDED 2026-10-11 as recommended. "Already claimed" is honest
   but vague. "The sender took it back" tells a stranger holding a leaked link something about
   the sender. *Recommend: "This voucher is no longer available"*, the same for a reclaim and a
   claim by someone else. Also recommend no ADR 0014 transfer signature on link sends in v1.
8. **Q8. Native app.** DECIDED 2026-10-11 as recommended. *Recommend: phase 5, and until then tell people to finish in the browser.*
   The parked claim cannot cross from the browser into the Capacitor app's storage without App
   Links.
