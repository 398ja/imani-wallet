# Changelog

All notable changes to the Imani wallet are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **Revocation reaches the owner's list from the mint (#160 phase 4).** Opening Settings →
  Terminals asks the mint (NUT-07, read-only) about every live row with a token, and marks
  revoked any whose credential is already spent: a device that took itself out of service, or
  one revoked from another of the owner's phones. Only a definite `SPENT` marks a row; an
  unreachable mint leaves it in service, so the one handle that can revoke it is never hidden.
  A **waiting** row marked this way also gives the gateway its pending slot back (`/cancel`), as
  revoking it from this phone does, so the owner is not blocked from adding a terminal for 24
  hours (#160 review).
- **The e2e covers revocation end to end.** `npm run e2e:terminal-setup` now has A revoke B,
  then B is refused at unlock with "no longer in service", B takes itself out of service, and a
  second device that hands itself back reads Revoked on A's list.

- **A terminal opens its till (#160 phase 3).** A device set up as a terminal now lands on
  `/terminal/unlock`, where its passphrase opens the till. Unlocking never opens a NAP
  session, so a terminal makes no call to `/api/v1/auth/*` and is never signed in as a
  customer. The mint's NUT-07 answer decides the session: `UNSPENT` opens FULL, unreachable
  opens REDUCED (redeem only), `SPENT` refuses with "no longer in service" (G8: before this,
  every terminal opened REDUCED because nothing asked the mint).
- **The till is its own app.** `TerminalApp` sits beside `AuthedApp` and starts no DM poll,
  wallet sync or push. It offers the till (terminal and stall name), Redeem, Settings →
  Security → Take out of service, and Lock. Every other path, the owner's dashboard included,
  lands on the till; a locked till sends every path to the unlock screen.
- **Redeem on a terminal says Paid (G12).** The customer's coupon goes to the stall, so a
  terminal's own wallet never sees it. On a terminal the Redeem screen asks gateway-core
  (`GET /api/v1/atomic/fulfilment/{id}`, NIP-98 signed by the terminal key) every 3 s, and
  only an answer naming this stall counts. The dev proxy routes that path to gateway-core.
- **The idle lock (decision 2).** An untouched till locks after the owner's chosen minutes (10
  by default, `0` is never), and Lock does the same. Locking drops the signer and keeps the
  12-hour session, so unlocking again within it needs only the passphrase.

### Security

- **A customer could fake "Paid" on a terminal's Redeem (#160 review, BLOCKER).** The till
  showed Paid for any fulfilment gateway-core reported, which was any completed send carrying
  the request id, and the payer sets that id. Reading it off the QR code and sending 1 sat to
  yourself was enough. The till now registers the request's terms with gateway-core before it
  shows the code (`PUT /api/v1/atomic/fulfilment/{id}`, first registration wins), and Paid
  needs the answer to name the stall as recipient and as issuer, in the request's unit, for at
  least the request's amount. An answer missing any of these, or a request gateway-core would
  not register, is never Paid. Needs imani-gateway-core#131.
- **A terminal credential needs a signer this build trusts (#160 review, IW-15).** The
  signature is checked against the `issuer_pubkey` the token carries, and an unset
  `VITE_VOUCHER_ISSUER_PUBKEYS` meant "unchecked". No deploy set it, so a credential re-signed
  with any key opened an issuing till for any stall. A terminal credential is now refused
  unless its signer is on the list, and an empty list refuses every one ("cannot confirm who
  issued this terminal's authority"). Customer coupons keep the old rule. **Deploy:** set
  `VITE_VOUCHER_ISSUER_PUBKEYS` to the gateway's voucher issuing key (imani-deploy PR), or no
  terminal opens.
- **A refused terminal is no longer stranded (#160 review).** A credential that cannot be read,
  is not this device's, or has an untrusted signer can never be handed back, so Take out of
  service failed and erased nothing. Those refusals now offer **Remove this terminal from this
  device**, which clears everything logout clears and says the owner should still revoke it.
- **A terminal record without its token stays a terminal (#160 review).** It used to read as not
  enrolled, so the device went to `/login` and its terminal key opened a customer session
  (spec 2.3). It now reaches the unlock screen, is refused, and is offered removal.
- **The idle lock is signed (#160 review).** The owner's idle lock is signed into the
  credential (`idle_lock_minutes`), and the till prefers it to the editable device record.
  Credentials minted before this fall back to the record.
- **The device record can no longer raise a terminal's role (IW-15).** Login read the stall,
  role and lock from `merchantMetadata`, `issuerId` and `permissions` stored beside the token,
  which anyone holding the device could edit: a redeem-only till could be edited into an
  issuing one. Login now reads them from the token's own bytes, after checking its single
  `P2PK_VOUCHER` lock equals the metadata's `lock_key`, its signature, and (where the build
  names them) its signing key. The record keeps only the token as authority, a record without
  one reads as not enrolled, and `completeEnrolment` refuses a token that does not match the
  credential it verified. `enrolledActor` and its `nosemgrep` are gone, so Semgrep reports 4
  findings, down from 5.

### Documentation

- **Spec 5.3 (terminals in service): `live: false` yields `[]`.** A not-live credential gets no
  permissions at all, not even redeem, and the stall must be an active merchant; ACL or
  gateway-customer failures fail closed. Matches gateway-core#130 after its review (imani-wallet#160).
- **Spec 5.3, 5.4 and 9.1 after the gateway-portal#80 review.** Core relays gateway-customer's
  `free` as `terminal:free`, and answers 503 (not `[]`) when gateway-customer or the ACL store is
  down. The portal replaces (not adds to) the request's authorities, caches only refusals so a
  revoked till is refused within 30 s, and never calls gateway-customer. New section 9.1 records
  the owner's phase 5 decisions: one nonce ledger without a `form` column (option b), and `free`
  computed by gateway-customer from the voucher list (option a).

## [0.14.3] - 2026-10-06

### Fixed

- **A voucher whose expiry was stored as a numeric string is no longer spent last** (#157).
  `expires_at` reached the wallet as an ISO string, a number in seconds or milliseconds, or a
  numeric string of seconds (what gateway-core's `/inspect` returned before v0.6.1, stored verbatim
  and carried to new devices by NIP-60 restore). The numeric string read as "never expires", so
  the voucher closest to being lost went last. Every coupon is now STORED with its expiry in one
  format, epoch seconds, whichever way it arrived (DM, claim, cashback, restore, import), and
  rows stored before this are repaired when the wallet opens: idempotently, safely with two tabs
  open. One parser replaces four copies that disagreed; it reads a zone-less ISO time as UTC and
  no longer takes junk like "12/31" for a date. A stored value nobody can read is repaired from
  the expiry signed into the voucher's own token; failing that it is kept as it was and logged,
  never turned into "never expires", and as a last resort spent first. When a
  sooner-expiring voucher is left for a legitimate reason (another stall, another currency, too
  small, or it cannot be divided to the amount), the pay screen says so in one line and the
  `[pay]` log records which voucher and why.
- **A far-future expiry is never stored as a past one** (#157 review). A "practically never"
  date such as 31 Dec 9999 is 253402300799 in seconds, which the old seconds/milliseconds
  boundary (1e11) read as milliseconds in 1978. The repair would then have stored a live
  coupon as long expired. The boundary is now 1e12, and converting to whole seconds rounds up,
  so storing can only keep an expiry where it was, never move it earlier.
- **Storing an expiry is now a fixed point** (#157 review). A value of 1e15 or more (for example
  1.7e15) was stored as 1.7e12 seconds, which the next read took for milliseconds in 2023, so
  the repair that runs on every open would have written a past date over a live coupon. Any
  value whose whole seconds would reach 1e12 is now unreadable, and is repaired from the
  expiry signed into the voucher's token.
- **The expiry signed into the token wins over the stored copy** (#157 review). The stored
  `expires_at` is only a cache; a readable but wrong copy no longer hides a live coupon as
  expired or changes its place in the spend order. The stored value is used only when the token
  carries no signed expiry.
- **Values no producer writes are unreadable rather than guessed** (#157 review): a fraction
  below 1e9 such as `'0.5'`, and a day that does not exist such as `'2026-02-30'`, which used to
  roll over into March.
- **An ISO date-time with no zone is now read as UTC** (#157), not as the device's local time,
  so the same stored value names the same instant in Nairobi and in London.
- **The pay screen's "sooner voucher not used" note matches what is spent** (#157 review): it
  compares issuers the way the wallet groups them (an npub keeps its case) and leaves out
  vouchers this wallet has already spent on another device, as the payment itself does.

## [0.14.2] - 2026-10-05

### Fixed

- **A new terminal can be put in service again.** 0.14.1 sent the terminal credential
  confirm and cancel calls (`POST /api/v1/wallet/terminal-credentials/{id}/confirm` and
  `/cancel`) with no body, so their NIP-98 signature carried no `payload` tag, and the
  gateway's filter refuses every POST without one (401 "NIP-98 payload tag required for
  POST"). On staging every terminal enrolled after gateway-customer V27 stayed unconfirmed
  and could never sell. The stall confirm, the device confirm and the cancel now send `{}`
  as JSON, signed in the `payload` tag. purchase-issuer's credential confirm now sends the
  same shape. It was not broken: it already signed the hash of its empty body.
- New tests run the real wallet signer against a port of the gateway's NIP-98 checks for
  each of these calls, so a missing or wrong `payload` tag now fails `npm test`.

## [0.14.1] - 2026-10-05

### Fixed

- **The wallet image builds again.** 0.14.0's Dockerfile runs
  `scripts/check-trusted-mint-build.sh` (#133), but `.dockerignore` excluded `scripts/`, so
  every `docker build` of the SPA image failed at that `COPY`. The script is now let into the
  build context. No app change: 0.14.0's code, buildable.

## [0.14.0] - 2026-10-05

### Security

- **No trusted mint known is no longer a pass (#133 review).** When the build names no mint
  and `/api/v1/config` names none either, which was the case on beta and prod, the gate used
  to answer `unchecked` and credit coupons from any mint. It now holds them instead (see
  below), the own-swap receive and the stall's claim sweep refuse, and the image build fails
  unless `VITE_TRUSTED_MINT_URLS` is set (`scripts/check-trusted-mint-build.sh`;
  `ALLOW_UNTRUSTED_MINT_BUILD=true` for a throwaway local image only). A dev build can opt
  out with `VITE_ALLOW_ANY_MINT_IN_DEV=true`, which is logged every time it is used and
  ignored in a production build.
- **The trusted mint is the one tokens are stamped with.** The wallet reads `token_mint_urls`
  from `/api/v1/config`, the PUBLIC mint URL customer-wallet stamps in `m`
  (imani-gateway-core serves it from the same setting). `mint_url`, gateway-core's
  client-mint setting, is still accepted but no longer the only source.
- **The cashback commit checks the token's mint before it swaps.** It used to swap and credit
  whatever mint the token named. A cashback token at a mint the wallet does not list is kept
  on the device, not swapped, and banked on a later visit once the mint is confirmed. The
  device's cashback stash is now a list, so a second held claim cannot overwrite the first.
- **Mint URLs carrying userinfo, a query or a fragment are never trusted**, even when empty,
  so two different strings cannot name "the same" mint.

- **The trusted-mint gate is on by default, in every build (#133).** The gate's other source
  used to be a script only the legacy bridge loaded, and its absence read as "this deployment
  names no mint", so many builds credited coupons from any mint. The wallet now asks
  `/api/v1/config` at start-up, and the coupon poller waits for that answer before its first
  receive. Until it arrives the list is unknown, which is never read as "no mint": a coupon
  that arrives meanwhile is deferred and received on a later poll.
- **The wallet checks where a received coupon's value is before every redemption (#131).**
  dm-poll asks `RedemptionAdapter.checkBacking` (which replaces an optional `getMintUrl` hook
  nothing called), and the wallet's answer reads plain ecash and legacy `cashuA` tokens as
  well as vouchers. A foreign unit or an unreadable token is refused before the mint swap; an
  unlisted mint is held (above). Mint URLs are compared as URLs: scheme and host case, a
  default port and a trailing slash do not matter, while a different host, port, scheme or
  path does. The vouchers' face currency (EUR, XAF, GBP) is not what is checked: their proofs
  are always sat.
- **The wallet-side receive swaps only at a positively trusted mint (#133).** It swaps at the
  token's own mint, so an attacker naming their mint would be paid. Any other verdict is
  refused. This path is not switched on yet (#123).
- **A coupon that arrived before the trusted list loaded is no longer lost.** It used to be
  refused at unwrap, which marked its delivery as handled for good. It is now deferred at
  redemption and offered again.
- **A re-signed voucher proof is credited for at most the sats burnt for it**
  (imani-gateway-customer#141). A successor's sats come from the swap that mints it, and the
  mint cannot see which blinded output carries a voucher secret, so a holder could burn a 1-sat
  proof, have a full-face successor signed, fund it with sats bought today and be credited up to
  the face. The gateway now signs a `max_sats` tag into every re-signed or split proof, summing to
  at most the burn. `parseVoucherToken` reads it per proof into `creditableSats` (each proof's
  amount clamped to its own bound), and `creditableFaceValue` and `exactFaceValue` credit
  `min(face_value, creditableSats × issuance_ratio)`. Every redeemer built on them follows: the
  till's DM validation and over-redemption guard, redemption rows, reconcile, the sender's receipt
  figure and wallet-api `/redeem`. A voucher with no `max_sats` is credited exactly as before. A
  `max_sats` that is present but not a canonical positive decimal credits 0, because reading it as
  absent would let a holder strip a bound by mangling it. The tag is a plain string tag, so the
  existing canonical bytes already cover it; a Java-signed fixture pins that the two agree.
- **An untagged locked voucher proof, or one whose own issuer signature does not verify, is
  credited 0** (imani-gateway-customer#141, security review of #176). The mint signs any blinded
  output, so the holder of a locked proof can mint a twin with the same secret funded with any
  plain sats; without a signed `max_sats` its sats say nothing about what the issuer funded.
  Every locked output the gateway issues now carries `max_sats` from birth
  (imani-wallet-lib#135), so only pre-#141 locked vouchers are untagged. And callers verified
  only proof 0's signature, so a self-minted later proof with the same `voucher_id` and lock was
  credited its full amount: `creditableSats` now verifies every locked proof's signature under
  proof 0's issuer key. Unlocked `VOUCHER` tokens keep crediting their sats (their signed blob is
  shared by every proof). **Consumers must act:** a pre-#141 locked voucher (a licence or
  terminal credential issued before this change) now has a creditable value of 0 at the till and
  wallet-api `/redeem`; it still verifies, so licence and credential checks are unaffected.
  **Superseded for untagged proofs by round 3 below.**
- **An untagged locked voucher proof keeps the pre-#141 crediting** (imani-gateway-customer#141,
  round 3). Crediting it 0 stranded real customer money held in pre-#141 locked vouchers. It now
  credits its sats, bounded by its signed face value and, across
  redeemers, by the shared ledger, exactly as before #141. A same-secret twin of a pre-#141 proof is
  therefore the **accepted legacy residual**, bounded by face and ledger; the gateway caps its
  re-signed and split successors at the voucher's recorded issued sats. Tagged proofs keep the strict
  `min(sats, max_sats)`, a malformed `max_sats` still credits 0, and every locked proof's own issuer
  signature is still verified under proof 0's issuer key (a forged later proof credits 0).
- **Round 4: the count behind the legacy rule, corrected** (imani-gateway-customer#141). Round 3
  justified this rule with "141 locked vouchers on staging, face about 1.13M". That figure counted
  the mint's NUT-20 quote `pubkey`, which every voucher quote carries since 2026-09-30, not the
  P2PK voucher lock. Read-only staging counts on 2026-10-04: since the gateway's 05:50Z restart, 2
  of 25 issuances were P2PK-locked (21 sats each); 0 of 2,316 stored purchase tokens are locked; the
  only stored locked successor is one 2026-09-29 test. Earlier locked issuances are not countable
  (sealed rows, no older logs) and, at that rate, are a handful. **The rule is unchanged, because it
  is still the safest choice:** the exposure it accepts is a few vouchers, each bounded by its own
  signed face and the shared ledger, while crediting 0 would strand those holders' money for no
  measurable gain, and a redeemer has no issuance record to bound them more tightly. No code change.
- **Test: a Java-signed `max_sats` 1 proof next to an unsigned `max_sats` 64 proof credits 1 sat**
  (imani-gateway-customer#141, round 5 review LOW-3). Pins, with real Java-signed bytes, that an
  unsigned later proof credits 0, and that one with no `issuer_sig` at all is refused. No code change.
- **An unsigned `processor` issuance warrant is refused on receipt** (#152). It names a
  payment record but carries no signature, and nothing on the device can check the record, so
  it was the issuing service's word alone, read as `claimed` and accepted. Any merchant session
  could have the portal mint one (imani-gateway-portal#54). `refuseIfUnwarranted` now refuses
  `claimed` before the mint swap with the same "Coupon not authorised" reason as `absent`,
  `unwarranted` and `failed`. The validation badge shows it as failed, and `isWarranted` no
  longer counts it. Merchant-signed coupons are unaffected.
- Card-purchase coupons are NOT refused: see the next entry, which ships with this one.
- **The till verifies a `delegated` issuance warrant, and card purchases sign one** (#152).
  A stall signs one kind-30078 delegation event with its own key naming a delegate pubkey
  (`p`), scope `coupon:issue` and a NIP-40 `expiration`; the delegate signs the same sale
  digest a `merchant` warrant signs. The event travels inside the warrant, so verification
  stays offline. `verifyIssuanceWarrant` checks the delegation is signed by the coupon's
  issuer, is scoped `coupon:issue` and unexpired, and that the warrant signature is the
  delegate's (`src/lib/issuerDelegation.ts`). `services/purchase-issuer` now signs a
  `delegated` warrant with each stall's terminal-credential lock key and keeps the Stripe
  reference as `ref` inside the signed bytes, so the coupon still reads as "paid by card".
- **The delegate signs the Stripe reference** (#176 review). The delegated digest is the sale
  digest's fields plus `ref` (`delegatedSaleDigest`), so an edited or removed `ref` fails
  verification rather than pointing the stall's reconciliation at another payment.
- **A delegation must be the stall's `imani:issuer-delegation` record** (#176 review): exactly
  one `d` tag with that value, at the till and in purchase-issuer's pre-mint check. Another
  app's kind-30078 record signed by the same key no longer delegates.
- **The stall's own ledger judges a card sale at the time it was recorded** (#176 review).
  `issuedVoucher` and `reconcileIssuances` check the delegation was in force then
  (`created_at <= issued_at < expiration`), so past sales no longer turn "failed" the day a
  delegation lapses. The till still checks against its own clock: a voucher carries no signed
  issue time. See `docs/explanation/delegated-issuance-warrant.md` and cashu-voucher#53.
- **purchase-issuer requires a delegation to outlive the coupon by 7 days** (#176 review), so a
  till clock running ahead or a slightly later gateway expiry cannot kill a coupon at the
  counter in its last days.
- A copied delegated warrant is refused where it is minted: gateway-customer spends each
  delegated warrant's `(issuer, nonce)` on voucher create (imani-gateway-customer#190). Binding
  the signature to one coupon was not possible: the gateway picks the voucher id after signing.
- **purchase-issuer mints nothing for a stall without a delegation** the till will accept,
  including one that would lapse before the 365-day coupon does. Such a purchase is
  reported BLOCKED (nothing minted) for the stall to sign a delegation; attach it with
  `npx tsx services/purchase-issuer/attachDelegation.ts <stall> <event.json>`, which
  refuses a delegation the till would refuse.

### Added

- **A fresh device can become a terminal** (#160, phase 2).
  - **Setup.** The logged-out screen offers **Set this device up as a terminal** (`/terminal/setup`), only on a device holding no key. The device shows its public key as a QR and as text, and polls the gateway and relay for a credential DM to it.
  - **Checks.** `terminalEnrol.offersFor` opens each DM with the pending key, inside the module. Every offer must pass `terminalDelivery.offerFromRumor`:
    - the seal is verified, and the rumor's author must equal the seal's;
    - the sender must be the stall the credential names;
    - the credential, from its own signed bytes, is locked to this device and issued by that stall, with a valid signature;
    - the DM is under 24 hours old.
  - **Confirmation.** The device shows the stall's public name and the same check code as the owner. The operator confirms, and a credential they reject is never offered again.
  - **Finishing.** The operator sets a passphrase of at least 8 characters (decision 2). `completeEnrolment` stores the credential, `voucherId` and idle lock, then sends a NIP-17 **enrolled** DM to the stall, sealed by the device key.
- **The owner's phone sends the credential to the device** (#160, phase 2). After minting, **Add terminal** gift-wraps a `imani-terminal-credential/1` DM to the scanned key, sealed by the stall. It is published to the relay and mirrored to the gateway, the way transfer signatures are. The form gains **Lock when idle**: 10 minutes by default, or Never, 5, 15, 30 or 60 (decision 2). The choice travels in the DM.
- **Owner side.** The Terminals screen polls for enrolled DMs while a row waits. `markInService` promotes the row whose device key AND voucher id match a notice sealed by that device, with no reload.
- `Entry` no longer sends a device enrolled as a terminal to `/login`, where its key would open a customer session. It says the till opens in the next version (phase 3), and offers **Remove this terminal from this device** (`removeTerminalFromDevice`), which erases the terminal key and record locally. It does not revoke; the screen says only the owner can.
- **The device accepts only the offer the owner's setup code names** (#160 review, MEDIUM). `verifyVoucher` checks the signature against a key inside the token, so a self-signed credential for an onlooker's own stall passed, and its `voucher_id` could be ground offline until the six-digit check code matched; the page then picked the newest offer. Now the owner's screen shows a setup code, `imani-terminal:1:<stall>:<voucher id>` (QR and text), the operator scans it on the device, and `offerFromRumor` refuses any offer not sealed by that stall for that credential (`not-the-expected-offer`). Nothing is offered before the code is scanned, and the device never picks among offers. Also refused: a DM dated more than 5 minutes ahead (`from-the-future`), and, when `VITE_VOUCHER_ISSUER_PUBKEYS` is set, a credential signed by an unknown key (`unknown-issuer`).
- On finishing, the device also calls `POST /api/v1/wallet/terminal-credentials/{id}/confirm` (gateway-customer#187), so the gateway's pending count frees the slot and the credential may issue.

- **Adding a terminal mints its credential from the owner's phone** (#160, phase 1). **Add
  terminal** now makes one NIP-98 call, signed by the stall, to `POST /api/v1/wallet/vouchers`
  (the body `scripts/mint-terminal-credential.mjs` sends, 365 days). It then waits for the token
  and checks it from its own bytes (`terminalMint.credentialDefect`):
  - it is a `P2PK_VOUCHER` locked to the scanned key;
  - the stall is in `pubkeys`, so the owner can revoke it;
  - it was issued by the stall, with a valid signature;
  - the signed metadata matches.

  A credential that fails any check is spent at once and nothing is recorded. A good one is
  kept on the owner's roster row (`token`, `voucherId`), and the screen shows a six-digit check
  code (`checkCode`, spec 4.2). Needs imani-gateway-customer#187, which mints the stall
  co-key.
- **Waiting rows are bounded, not counted** (#160 decision 4). Waiting rows do not use up the
  free terminal. They are capped at 2 (`TOO_MANY_WAITING`, "Two terminals are already waiting
  for their device") and expire after 24 hours. The Terminals screen cancels expired rows by
  spending their credential. The client check is a hint: gateway-customer#187 enforces the same
  limit and the 24 hours at mint time (409 `TERMINAL_PENDING_LIMIT`), and Cancel tells it the
  slot is free (`POST /api/v1/wallet/terminal-credentials/{id}/cancel`).

### Fixed

- **The owner's app confirms a terminal at the gateway** (#160 round 2, MEDIUM). The device's
  `/confirm` ignored every error, and the owner never confirmed. So a lost confirm left the list
  saying *In service* while gateway-customer refused Sell (410 after 24 hours). Now, when the
  owner's app sees the enrolled DM, `confirmEnrolled` (`terminalConfirm.ts`) confirms as the
  stall, retrying with backoff from 30 s, doubling, and capped at 1 h. The device still tries,
  best effort. The roster keeps `gatewayState` (`unconfirmed`, `confirmed`, `lapsed`), and the
  list shows it.
- **A credential finished by `resumeMinting` gets its setup code and DM** (#160 round 2).
  Waiting rows show their setup code on the list. `deliverWaiting` sends the credential DM to
  any waiting row not yet `delivered`, including rows `resumeMinting` completed.
- **Remove from device clears what logout clears** (#160 round 2). `removeTerminalFromDevice`
  now also sweeps every `imani-wallet:*` key (`sweepAppStorage`, shared with logout), the resume
  cache, and the terminal's wallet database. It reports what it cleared. A `keyStore` failure no
  longer skips the rest, and the screen says so instead of navigating away.

- **A server error while adding a terminal no longer forgets a credential that may exist**
  (#160 round 2). Any HTTP status used to clear the `minting` row and its Idempotency-Key, so a
  proxy 504 after the gateway minted left an unknown credential holding a pending slot. Now only
  a definitive 4xx (not 408 or 429) clears it (`isDefinitiveRefusal`). A 5xx, timeout or network
  error keeps the row, and `resumeMinting` re-sends the same key. The enrol screen and
  `resumeMinting` share one `settleMintFailure`.
- **A wrong credential that was spent gives its gateway slot back** (#160 round 2). The
  defect-spent paths now call `/cancel`, so the slot is free at once rather than after 24 hours.
- **Credentials minted outside the app are confirmed** (#160 round 2). Since gateway-customer
  V27 an unconfirmed credential cannot sell. `scripts/mint-terminal-credential.mjs` now confirms
  what it mints, as the stall, and fails on anything but 204. `services/purchase-issuer` sells
  with `X-Imani-Terminal-Credential`, so it is affected too: it confirms each credential once,
  as its device, before first use, and retries until the gateway says yes.

- **Re-adding a device already on the list no longer orphans its first credential** (BLOCKER).
  `recordTerminal` replaced the row for the same key, so a second Add minted a new credential
  and dropped the token of the first, which stayed live and could no longer be revoked.
  `checkEnrolment` now refuses a key with a live credential (`ALREADY_LIVE`, "already on your
  list with a live authority. Cancel or revoke it there first"), and `recordTerminal` throws
  `LiveCredentialError` rather than replace such a row. A revoked device can still be added
  again.
- **A credential whose answer was lost is no longer orphaned.** A `minting` row, with the
  request's `Idempotency-Key`, is written before the mint request. The voucher id is added as
  soon as the gateway names it. If the token poll times out, or a wrong credential's cancelling
  spend fails, the row stays. The next open of Terminals (`resumeMinting`) fetches and checks the
  token, re-sends the request with the same key so the gateway replays rather than re-mints,
  retries the spend, or clears the row when the gateway refused. Rows read *Still being set up*
  meanwhile.
- **Phase 0 waiting rows no longer block Add.** They hold no token, so they are not counted
  against the two-waiting limit, and the list offers **Remove** for them (nothing was minted).
- **A minted credential must name exactly the stall as co-spender.** `credentialDefect` used
  `includes`, so a third key in `pubkeys` passed. It now requires `pubkeys` to be exactly
  `[stall]`, `n_sigs` 1, and no `refund` or `locktime` tag.

- **Revoking a terminal spends its credential** (#160, phase 1, G10). Revoke (and **Cancel**
  on a waiting row) used to mark a local row and nothing else, so the terminal kept its
  authority. `revokeTerminalAtMint` now spends the credential with the stall's key and marks the
  row only when the spend landed or the mint says it is already spent. Otherwise the row stays
  in service and the screen says the revocation did not reach the mint. `witness.ts` now signs
  for a secret whose NUT-11 `pubkeys` tag holds the wallet's key (`spendingKeys`, `n_sigs` 1
  only). Rows set up by hand before this have no token, offer no Revoke, and say *Set up before
  revocation existed: add it again*. `TerminalRecord.revocationSecret`, which was never written,
  is replaced by `token`, `voucherId` and `waitingUntil`.

- **A coupon held for over a week can still be released (#175 review).** Re-offering held
  coupons looked back from when the message was written, but relays filter on the gift
  wrap's own timestamp, which NIP-59 backdates by up to two days, so such a wrap was never
  found. `reofferEvents` now reaches back a further `GIFT_WRAP_BACKDATE_SECONDS` (2 days + 1 h).
- **A coupon at an unlisted mint is held, never dropped (#133 review).** A refusal used to be
  terminal, so a mismatch between the two services' mint settings (a migration, or an
  internal URL configured for client-side minting) would have discarded every genuine coupon
  it touched. Now nothing is swapped, the delivery is not consumed, and the wallet shows
  "N coupons are waiting to be verified" until the configuration names the mint, when they
  arrive on their own. Only a foreign unit or an unreadable token is still refused.
- **Waiting for the trusted mint heals itself.** A failed or empty `/api/v1/config` is asked
  again on a backoff (5 seconds, doubling to 5 minutes). When it answers, the poller catches
  up and re-offers every held coupon by id, including ones older than the 7-day poll window.
  A config without a NIP-05 domain no longer stops the mint from being read.
- **A sale finished after a gateway crash reaches the customer** (imani-gateway-customer#168).
  Sell now tells the gateway who a quote-backed coupon is for
  (`PUT /api/v1/wallet/vouchers/{id}/recipient`) before it polls for the token. If the gateway
  crashes mid-sale and finishes the coupon minutes later, after this screen has stopped polling,
  the gateway sends it to that customer itself. Best effort and bounded: the registration is
  abandoned after 5 seconds, so a gateway that never answers cannot stall the sale, and an older
  gateway's 404 lets the sale go on as before. A failed registration is logged with
  `console.warn` (voucher prefix and status only, no key or token).
- **The timeout message tells the truth about who delivers.** When the poll runs out and the
  gateway accepted the registration, the merchant reads that the gateway will finish and send the
  coupon, and not to sell it again. When the registration failed, the gateway does not know the
  customer, so the merchant is told to check the voucher in a few minutes and forward it
  themselves, instead of being promised a delivery that will not happen.
- `e2e/stack/crash-mid-sale.sh` uses the `up.sh` next to it unless `STACK_UP` says otherwise,
  rather than a path on one developer's machine.
- **Adding a terminal no longer claims it can trade** (#160, phase 0). The screen said
  "<name> can now trade for your stall" when no credential had been minted and nothing had
  reached the device. It now says **Waiting for the device**, that the terminal cannot take
  payments yet, and the owner's list shows the row as *Waiting for the device* rather than
  *Never used*. Rows gain an optional `status` (`waiting`, `in-service`); older rows read as
  before.
- **A code that is nobody's key is refused** (#160, phase 0). `checkEnrolment` now refuses 64
  hex characters that are not a point on secp256k1 (`NOT_A_KEY`), before anything could be
  minted. The gateway issues an unlocked, bearer credential for such a key.
- **Terminal setup never overwrites a wallet key** (#160, phase 0). `completeEnrolment` refuses
  while the key store already holds a key, so a person's wallet key in the single key slot
  stays loadable. They log out first, where they see the backup warning.
- **The terminal lock check compares with the unlocked key** (#160, phase 0, G9).
  `useTerminalIdentity` took the device key from the record it was checking, so the lock
  check compared the record with itself. It now takes `devicePubkey` from the session's
  unlocked key. A record naming another device grants no terminal authority and the mint is
  not asked. Consequence: `beATerminal()` in `e2e/terminals.e2e.ts` no longer turns the
  owner's browser into a terminal; its role-gating checks return with phase 3's terminal
  unlock.
- **A terminal record for another device no longer locks the owner out** (#160 review). Such a
  record is ignored, exactly as a missing one is, so the owner's home screen stays their own
  instead of showing *This authority is not for this device*. Nothing is granted: no terminal
  actor is produced and `canTrade` is gated by the gateway.

### Changed

- `@imani/dm-poll`: `BackingVerdict` gains `hold` (with `HoldReason`), and the service emits
  `redemption:held` and `redemption:released`. `untrusted-mint` moves from `RefusalReason` to
  `HoldReason`. New `DmPollService.reofferEvents(ids, since)` and `hasProcessed(id)`.

## [0.13.0] - 2026-10-04

### Fixed

- **A terminal no longer reports a sale the customer's wallet refused** (#159). A terminal's
  key is not the stall's, so its Sell sent a signed `none` warrant, and every wallet that
  receives a coupon by DM refuses `none`, `absent` and `failed` warrants before the mint swap.
  The customer's wallet showed "Coupon not authorised" with nothing added while the terminal
  said "It is in their wallet now". Decision (Option B): every recipient keeps refusing, so a
  customer is never left holding a coupon the issuing stall will refuse. Sell on a terminal
  now stops on arrival, before a customer is scanned or payment taken, saying terminal sales
  need the `delegated` warrant form, which is not supported yet. `issueAndDeliver` refuses the
  same request before anything is minted, and also refuses an owner sale whose warrant would
  be `none` (session key is not the stall's) or absent (wallet locked). Comments on
  `refuseIfUnwarranted` and `isWarranted` now describe this behaviour; `isWarranted` is noted
  as not wired into any screen. Cashback is closed the same way: `/sell/cashback` on a
  terminal stops on arrival, and `prepareCashbackAttempt` / `issueCashback` refuse a terminal,
  or an owner issue with a `none` or absent warrant, before anything is minted. (The cashback
  claim records an unwarranted verdict without refusing, so the customer would otherwise hold
  a code the issuing stall's till refuses.) A terminal's home screen no longer offers Sell and
  says selling is not available yet, and the "Sell and redeem" role says so at enrolment.

- **A cashback voucher's detail no longer reads like a sale** (#155). It showed "Paid: At the
  counter" and "Customer receipt: Not collected", which are Sell questions with no answer for
  value the stall gave away. It now shows what it is ("Cashback from this stall"), whether the
  customer claimed it from the same stored portal status the list uses ("Claimed on <date>",
  "Not claimed yet", "Expired unclaimed", "Withdrawn", "Needs a check", "Status unknown"),
  and the authorisation line as before. A code past its expiry that the portal never
  answered for reads "No claim on record", not "unclaimed", because nothing asks about it
  after expiry. Its transaction link says "The cashback this came from". Sell vouchers are
  unchanged.
- **Cashback coupons now show what was checked (#156).** A coupon redeemed from a cashback
  code skipped the issuer and signature check every other receive runs, so its detail screen
  read "Issuer: Not checked". The check now runs on redeem and is recorded on the row, so a
  genuine coupon reads "Signature verified" and a forged, unsigned or unrecognised-issuer one
  reads as failed rather than unchecked. Recorded, not refused: the claim is one-shot, so
  refusing would lose the value. Cashback still does not attest to the ledger. Cashback rows
  saved before the fix are re-checked from their stored coupon when opened.
- A cashback coupon now lives as long as a Sell coupon from the same stall
  (398ja/imani-gateway-portal#58). The generate request sends the stall's
  `voucherValidityDays` (0 for never expires) next to the claim-window
  `expiryDays`, which is unchanged. Needs a portal that reads the field; an
  older portal ignores it and keeps its default.

## [0.12.0] - 2026-10-01

### Added

- **A browser probe for #144** (`e2e/probe-cashback-spend.mts`). A till issues a cashback, a
  customer redeems it and pays it back to that till. The probe checks the warrant is in the
  coupon, the till books the payment, the portal stores the claim on its own, and the till's
  Vouchers list shows the cashback. Before the fix, staging failed 9 of 15 checks.
- **A browser probe for #145** (`e2e/probe-concurrent-redeem.mts`). Two customers pay one
  till at the same instant over live SSE, round after round, and the probe reads the till's
  own store to check each coupon is booked against its own voucher. On staging, 0.11.1 passed
  44 of 44 checks and 0.11.0 failed 7, including two refused honest payments. `E2E_BUNDLE_DIR`
  runs it against another build for a control run.
- **Cashback vouchers on the Vouchers list (#144).** A cashback code now stores the
  `voucherId` the portal returns and appears on `/merchant/coupons` beside Sell coupons, with
  its claim state in plain words: "Not claimed yet", "Claimed", "Withdrawn", "Expired", "Needs
  a check" or "Status unknown". Opening the list asks `GET /portal/cashback/{id}/status` once,
  only for cashback rows that are still open and not past expiry, at most 3 at a time, and
  gives up on one after 8 seconds. Its detail screen shows what was claimed and checks the
  warrant against the stall key. A second device gets the row back through the existing NIP-60
  history records.

### Fixed

- **A merchant could not take back a cashback coupon they issued (#144).** The wallet signed
  the issuance warrant only after the code was minted, so the warrant never got into the
  coupon's signed secret, and the till refused it as "Coupon not authorised". The warrant is
  now signed first and sent as `issuanceWarrant` on `POST /portal/cashback/generate` (needs
  imani-gateway-portal#52). The history row keeps that same string. If the portal refuses the
  warrant (`INVALID_WARRANT`), the merchant sees a message that says so, not a generic error.
  wallet-api's `/v1/cashback/generate` now passes the caller's `issuanceWarrant` through
  unchanged, and refuses one over 4096 characters as the portal does. It used to drop it. A
  terminal still sends a signed `none` and is still refused, which needs the `delegated` form.
  Codes issued before this fix cannot be repaired.
- **A cashback voucher had no redemption ceiling (#144).** Redemptions were matched to an
  issuance only when the row was a Sell coupon. A cashback's redemptions were filed against
  nothing, so its claimed figure stayed at zero and the over-redemption ceiling did not count
  its earlier parts. A till could take more than a cashback's face. The claimed figure, the
  ceiling, the row repair and the claim sweep now all ask one question,
  `isVoucherIssuance`, which counts a cashback as an issuance.
- **A retried cashback could mint a second code for one sale (#144).** After a network error,
  a retry or a second press sent a fresh `idempotencyKey`, so the portal could mint a SECOND
  cashback for the same sale. The issue screen now signs the warrant and picks the key once
  per issue, and resends both unchanged on every retry. The portal's idempotency check now
  stops the duplicate, so the till's warrant ceiling is no longer the only guard. Changing
  the amount, note or expiry, or finishing an issue, starts a new key and a new warrant.
  A second press while one is still in flight does nothing. If the portal answers
  `IDEMPOTENCY_CONFLICT`, the merchant is told plainly that no second code was made.
  A press made while the wallet was locked is never reused once it is unlocked, so that
  retry is signed rather than minted unwarranted. Switching account or stall starts a new
  key and warrant. A definite refusal (a 4xx other than 409) ends the attempt. A network
  error, a 5xx or a 409 keeps it for the retry.

## [0.11.1] - 2026-10-01

### Fixed

- **A till no longer refuses the honest last coupon of a voucher after two coupons arrive together
  (#145).** The legacy bridge kept one correlation slot for the redeem in flight, but redeems do
  overlap (SSE does not wait, and the per-voucher lock covers only one voucher). On staging song's
  till redeemed 206 sats of voucher 19c4fed1 and 1365 sats of another voucher 21 ms apart. The
  second redeem's stamp landed on the first row, so 19c4fed1 carried two rows for one redemption
  (89.93 booked instead of 74.91), and the customer's last honest part (208 sats, 15.17) was
  refused as "already spent". Each redeem now gets a random correlation id, carried on the voucher
  row it writes, and a row is stamped only by the redeem it names. The cashback receive registers
  too, so it can never pick up a DM coupon's claim.
- **The ledger files every row under the voucher its own coupon names (#145).** Rows the race
  already wrote are re-filed, not dropped: a row stamped with one voucher but carrying another's
  coupon counts in full against the coupon's voucher, valued from the coupon, so that voucher can
  not be taken twice either. Copies of one received token count once; two different coupons never
  merge, whatever their stamps share. A row whose coupon cannot be read keeps its stamp and still
  counts. The redemption ceiling, the claim filed for a part and the merchant's claimed figure all
  read these same rows, so song's 208 part is taken and filed at 16. No rounding tolerance was
  added: at 19c4fed1's real ratio the full 1371 sats are exactly the face of 100.

### Added

- **A refused coupon shows on its payment (#145).** "1 of 2 coupons refused: that coupon is already
  spent", with "ask the customer to pay the rest", on the transaction screen for as long as it is
  shown rather than only in a ten-second toast. The ids a refused coupon names are written by its
  sender, so the instruction is given only when the refused coupon came from the payment's own
  payer. Anything else naming the payment is shown neutrally ("a coupon naming this payment was
  refused"), and only while a payment request is still open. The `redemption:refused` event now
  carries the bundle id, its declared part count, the request id and the payload's payer. A
  cashback coupon refused as unauthorised (#144) shows the same way when its DM names the payment.

### Changed

- **The receive pacer's notes cite the new server default** (120 a minute from
  imani-gateway-customer 0.19.2). The client keeps 8 calls a minute, which is safe against any
  gateway and costs time against one on 120. Related: imani-gateway-core#114 (FLOOR
  rounding on proportional sends) is unchanged.

## [0.11.0] - 2026-09-29

### Fixed

- **A cashback code can be redeemed again.** Since gateway-portal 0.4.0 a code is ten random
  characters, `CB-XXXXX-XXXXX`, but the wallet only recognised the old six-character
  `CB-XXXX-YY`. So the Redeem button stayed disabled for every code a shop issued. Both shapes are
  now accepted, in any case and with or without dashes and the `CB` prefix, as the portal does.

### Added

- **A live re-lock probe, `reissueProbe.test.ts` (`PROBE_REISSUE=1`).** It runs against the real
  staging gateway and mint with nothing faked. A coupon is issued locked to A. The gateway
  refuses a re-signature before the burn (`PREDECESSOR_NOT_SPENT`) and refuses a stranger who
  knows both secrets (`NOT_AUTHORISED_BY_HOLDER`). It re-signs for A once, returns the same
  successor to an identical retry and refuses a second proposal (`PREDECESSOR_ALREADY_CLAIMED`).
  The mint then refuses the successor without B's witness and accepts it with one. It passed on
  staging on 2026-09-29.

### Changed

- **`reissueVoucherSecret` signs as the coupon's holder (imani-gateway-customer#136).** It
  sends `lock_authorization`: a BIP-340 signature by the key the predecessor is locked to, over
  `sha256("imani/voucher-reissue/v1" || u32be(len) || predecessor || u32be(len) || proposed)`.
  The key is borrowed from the session signer for the one signature (IW-14), never passed in
  or kept. A caller whose coupon is locked to another key, and the tests, pass a `lendKey`
  that lends it the same way.
  The gateway refuses a re-signature without it, because knowing a coupon's secret is not
  holding it. `NOT_AUTHORISED_BY_HOLDER` is a known, permanent refusal. The gateway pins a
  signature made by this code, with a key whose y is odd and a non-ASCII proposal, so the two
  languages cannot drift apart unnoticed.

## [0.10.0] - 2026-09-29

### Fixed

- **The trusted-mint gate is actually on in deployed builds (#133).** The gate reads
  `VITE_TRUSTED_MINT_URLS`, which nothing set, and otherwise falls back to the gateway's config,
  which only loads through the legacy bridge. So a default build trusted no mint in particular,
  answered `unchecked`, and credited coupons from any mint. The Dockerfile now takes
  `VITE_TRUSTED_MINT_URLS` as a build argument, and imani-deploy passes the staging mint.
  Verified in the built bundle: set, `trustedMintUrls` starts from
  `"https://mint.staging.398ja.xyz"`, unset it starts from an empty string.

- **A coupon is refused unless its proofs are at a trusted mint, in sat.** A coupon's value
  is not in the coupon, it is in the proofs at a mint, and the issuer signature covers no mint
  at all. So a copy of a genuine signed coupon backed by proofs from a mint nobody has heard of
  verified perfectly and was credited as money. The wallet read the mint URL and the unit and
  checked neither. Both crediting paths now refuse one they do not recognise. The trusted mint
  can be set with `VITE_TRUSTED_MINT_URLS` (comma-separated), and otherwise falls back to the
  mint the gateway names, so a wallet is protected without configuration. While that answer is
  still outstanding a coupon is deferred rather than waved through, since otherwise delaying one
  request would turn the check off.

- **A network blip while a send settles no longer reports it as unsent (#125).** One failed
  status read threw out of the wait, so a part the gateway had completed was shown as "Partly
  sent ... send the difference again", which pays it twice. A failed read now leaves the outcome
  unknown and the wallet keeps waiting. If it is still unknown at the end, the send is reported as
  still going through and is finished from the pending ledger on the next login.
  - **A bundle part whose outcome stays unknown is reported as in flight.** The send and pay
    screens show "still going through ... do not send it again" and no longer offer to send the
    difference.
  - **Faster answers from a gateway that cannot confirm:** a status read refused with a 4xx
    stops the wait at once. A 429 is re-read no sooner than its `Retry-After`.
- **A send whose outcome is unknown can no longer be paid twice (#128).** Pressing Send or Pay
  again drew on another coupon and paid the same person a second time. Now:
  - a second send to the same person, or a second payment of the same request, is refused while
    the first is unconfirmed, in the payment code itself and not only on the screen;
  - coupons behind an unconfirmed send are left out of what the Send and Pay screens offer;
  - after an unknown outcome the button reads "Still going through" and is locked, with Back
    locked too (it would clear the lock) and Done as the way out.
  A send unanswered for over a week stops holding anything back, the same limit reconciliation
  already used (#127).

### Added

- **Groundwork for the wallet to swap its own receives** (imani-gateway-customer#133,
  imani-wallet#123). The gateway performs the receive swap today, which is why it keeps a
  spendable copy of every coupon received and why a lost response leaves it holding the only
  copy.

  Built and verified against the real mint: the wallet-side blinding and swap, the intent
  record that makes a lost response recoverable, a transport against the mint, the join from a
  token string to a swap, a start-up sweep that finishes interrupted receives, and a client for
  the gateway's voucher re-signing endpoint.

  **Not yet wired in**, so neither bug is closed by this release. What remains is the
  switch-over itself and a voucher receive, which needs two swaps because the gateway will only
  re-sign once the predecessor is spent while the wallet needs the signature before it swaps.
  A voucher is refused rather than stripped of its identity in the meantime. See
  `docs/explanation/the-wallet-swaps-its-own-receives.md` for the current status table.

## [0.9.1] - 2026-09-28

Pairs with imani-gateway-portal 0.9.0 (token in the create response); still works against an
older portal by polling.

### Changed

- **Sell uses the voucher returned by the create call when it already carries its token
  (imani-gateway-portal#48).** Until now Sell always read each new voucher back from the gateway
  to get its token. That read is served from one gateway instance's memory, so a restart, an
  eviction or a request landing on another instance returned 404 after the backing had been spent.
  Vouchers still awaiting payment, and every voucher from a portal that predates the field, are
  polled as before.

## [0.9.0] - 2026-09-27

Pairs with imani-gateway-customer 0.15.1, whose `409 RECEIVE_ALREADY_SETTLED` and unpaced ack
this relies on.

### Fixed

- **A coupon swapped at the mint can no longer be lost to a retry of itself (#110).** The receive
  idempotency key had a random suffix, so a retry of a token whose first swap had already
  succeeded went out under a new key, re-swapped spent proofs and failed with 11001. The key is now
  `rcv_<SHA-256 of the token>`, the same on every attempt. It is never derived from TokenSecurity's
  prefix-based fallback fingerprint, which two tokens can share.
- **A settled receive the wallet does not hold is never shown as money or as success (#110).** The
  gateway's same-key replay returns the receive_id with no fresh token. The wallet used to fall
  back to saving the original, already-spent token, which is a balance with nothing behind it. That
  case, the gateway's `409 RECEIVE_ALREADY_SETTLED` (id read from `X-Receive-Id`, else `details`),
  and an 11001 on a token the wallet already has a receive_id for are now a distinct "settled at the
  gateway, not saved here" state. It is terminal for re-swapping, never reported as received, and
  logged with its receive_id for reconciliation.
- **Escrow acks are retried instead of dropped, and only for saved value (#110).** An escrow is
  acknowledged only after its voucher is saved. A failed ack retries in the background, honouring
  `Retry-After`. Saved-but-unacknowledged receive_ids are kept per account (bounded, localStorage)
  and flushed at startup and on catch-up, at most two per run, through the pacer, stopping at any
  429.
- **A rate-limited burn retries once after `Retry-After` (#110)**, like a 409.
- **A multi-voucher payment no longer blows the gateway's rate limit (#110).** Receives, acks and
  burns share one pacer counted in calls (8 a minute, under the gateway's 10). The bundle wait
  window grows from 3 to 10 minutes to outlast the conservative pacing bound plus the 429 retries.
- Receive, persist and ack are logged by receive_id (never the token).

## [0.8.0] - 2026-09-27

### Added

- **A payment sent as several vouchers reads as one payment (#94).** Sending €6 from €3 + €3
  coupons used to give the recipient two "€3.00 received" toasts and two bell rows, and the sender
  two "€3.00 was claimed" lines, with nothing saying €6.00 or "2 of 2". Now each side sees one
  toast and one bell row that updates in place: "€3.00 of €6.00 (1 of 2 vouchers so far)", then
  "€6.00 received (2 vouchers)". The advance "on its way" notice collapses the same way, and the
  sender's success screen says "Sent as 2 vouchers".

  **Declared and received are kept apart.** The total and count come from the sender and are
  unverified, so they are only ever shown as "expected". The headline is always what actually
  redeemed; nothing about balances, ledger rows, redemption ceilings or request settlement reads
  the declaration. The first declaration wins, and a later part that disagrees, comes from another
  sender or is in another currency is flagged and announced on its own rather than folded in.

  **A part that never comes is said so.** Three minutes after the first part (longer than the
  wallet's own rate-limit retries, so a queued part is not called missing), an unfinished payment
  reads "€3.00 of an expected €6.00 received. 1 voucher has not arrived." as a warning that stays
  up until dismissed. A part waiting out the rate limiter shows as "1 of 2 in, 1 still receiving"
  on the same toast instead of a toast of its own, including when it is the first part to arrive.
  Merchant tills get the same one-toast-per-payment treatment; request settlement still sums the
  individual rows. A single-voucher send, or a sender that does not declare a bundle, behaves
  exactly as before.

- **A payment of several vouchers is one line in history (#106).** The Transactions list, for
  customers and stalls, folds the rows of one multi-voucher payment into a single line showing
  the total and a "2 vouchers" tag. Tap it and the rows it was made of open underneath, each still
  linking to its own record. The total is the sum of those rows, never a figure the sender
  declared, and rows in different currencies or directions are never added together. Settling
  payment requests and reconciling merchant claims still read the individual rows.

### Changed

- **The send and pay confirmation say it in one sentence.** "Sent to Alice as 2 vouchers."
  replaces a second grey line under the amount; when a payment stops short, the count moves into
  the warning that explains it.
- **Amounts line up.** Transaction amounts use tabular figures, so a payment's total and the
  vouchers beneath it share one column the eye can add up.

### Fixed

- **Lint is clean.** `npx eslint .` reports nothing: the `withPrivkey` callback is no longer named
  `use` (which the hooks rule mistook for React's), and a handful of unused imports and parameters
  are gone.

## [0.7.0] - 2026-09-22

### Added

- **A Vouchers entry on the merchant menu, and a record behind each one.** A stall could see the
  coupons it had issued only by going through Transactions, and the screen behind a coupon could
  say what was issued and nothing about what happened next. The menu now carries **Vouchers**
  between Dashboard and Transactions, listing what the stall put into circulation.

  **Still-valid vouchers lead, expired ones are one switch away.** A merchant trades against the
  live ones, so a list led by last year's lapsed coupons buries the answer. But the customer most
  likely to present a coupon at a counter is the one holding a coupon that has run out, so they
  cannot simply be absent. The switch says how many are behind it, and the heading follows the
  switch rather than counting a set the list is not showing.

- **What has actually been claimed against a voucher.** The question a merchant opens the record
  with, and the one it could not previously answer. A coupon is spent down rather than used up, so
  one issuance legitimately comes back several times — the figure is a sum over every incoming row
  sharing the voucher id, shown beside what is still outstanding, with the claiming transactions
  listed underneath so the total can be checked rather than only believed.

  The trap here is real and is pinned by a test: stored rows carry a hardcoded `direction: 'in'`,
  so anything reading direction off the row rather than through `toTransaction` would report a
  voucher fully claimed on the day it was sold.

- **The evidence behind a sale, as three lines that are never collapsed.** How it was paid for,
  whether the stall authorised issuing it, and whether the customer said money arrived are three
  different claims, and merging any two lets a merchant read authorisation as proof of payment.
  Each line carries what it does and does not establish, on screen rather than behind a tap, and
  each carries its own **glyph as well as its colour** — a tick, a dash, a warning triangle — so
  it still reads for anyone who cannot separate green from grey from red, in sun at a stall, or
  in a greyscale screenshot.

  **Cash or card has three answers, not two.** A processor warrant is evidence of a card payment;
  a stall-signed warrant is evidence of a sale made at the counter. Everything else — every sale
  issued before warrants shipped, and every sale made on a terminal, whose key is not the stall's
  — reads as *not recorded*. Printing "cash" over those would be the wallet inventing a fact about
  money.

- **How much of a voucher has come home, drawn as well as written.** The claimed figure and the
  face value are one panel rather than a hero and two label/value rows underneath it, with the
  proportion shown as a fill: "how much of this is left" is a proportion of a known whole, which
  is the one thing a bar says faster than a sentence. Both figures are still written out at full
  precision beside it — the bar is the fast path, the words are the fact. An expired voucher's
  remainder is called *lapsed* rather than *outstanding*, because nobody can walk in with it and
  the stall no longer owes it.

### Changed

- **A voucher row now opens the voucher rather than the transaction that issued it**, on the
  issued list, the expiring list, and a scanned pass. The question behind the row is what happened
  to this coupon; the issuing movement is one row further in, as a link rather than an id.


## [0.6.1] - 2026-09-21

### Fixed

- **A large sale delivered nothing, and left the wallet unable to receive anything afterwards.**
  Reported as "selling 1000 GBP breaks the system: five batches of 200 were expected, none
  arrived, and since then nothing goes through". Both halves are on the receive path and both are
  reachable only once a sale is big enough to be split and chunked - a Cashu token carries one
  ~1840-char proof per set bit of its amount, so the parts of a large sale are the biggest tokens
  this system ever sends.

  `MAX_CHUNKS` was 16, copied from one deployment's `max_chunks` and enforced as though it were a
  protocol constant. It is the *sender's* setting. A transfer split more ways had every piece
  refused by `asChunk`, which answers null for "not a chunk" and "a chunk I refuse" alike - so the
  envelope fell through to the text parser, yielded no token, and was marked processed forever.
  The gift wraps are still on the relay; the local tombstone was the only thing in the way. The
  ceiling is now 64 with the byte bound derived from it, and `looksLikeChunk` keeps a refusal
  retryable instead of turning it into a deletion.

- **Why it stayed broken.** The completed-transfer set lived in memory while the processed-event
  tombstones it partners with live in `localStorage`, so a reload dropped one and kept the other:
  a big coupon's stragglers came back with no sibling that could finish them and rebuilt a wedged
  pending entry on every poll. Its TTL was also 24h against a 7-day fetch window. The set is now
  persisted, sized to the window, and outlives it.

- **`maxProcessedEvents` was dm-poll's default 100 against that same 7-day window.** One large sale
  is up to 80 gift wraps, so the set evicted ids still inside the window, which were re-fetched,
  re-processed, and evicted the next batch in turn. It never converged - every cycle a full round
  of redundant unwraps and mint round-trips, surviving a reload because the set is on disk. Now
  sized against the window.

- **The chunk amnesty could not run for the coupons the 16-chunk ceiling ate.** It exists to forget
  exactly these tombstones, but its key was unversioned and had already fired on every affected
  device for the earlier pre-reassembly bug. The key is versioned now, so a later fix can declare
  that the tombstones written before it are not to be trusted.

### Performance

- **A catch-up no longer freezes the page.** Sizing the processed-event set to the fetch window made
  an existing O(n) write into an O(n^2) one: dm-poll saves the set on every event it finishes and
  `localStorage.setItem` is synchronous. Measured over a 2000-event pass - 134MB serialised across
  ~1800 blocking writes, the largest ~335KB. Writes are coalesced now: the same pass does one write
  of 0.134MB. The received-token set stays synchronous, because it is the first line of defence
  against crediting a coupon twice and must survive a crash.

- **The received-token set was re-parsed from storage on every event.** `hasTokenBeenReceived` runs
  once per event and `markTokenAsReceived` re-read the whole set again to add one entry. Measured
  over a 2000-event catch-up against a 5000-entry set: ~350MB parsed and ~1.8s of blocking work,
  all re-deriving a value that had not changed. Held in memory now, mirrored to storage: 1784ms ->
  0.8ms. Dropped on an account switch, so one account cannot answer another's "have I banked this?"

- **That set also had no bound at all**, so every coupon a merchant ever banked made receiving money
  permanently slower. Capped at 2000 - the cap bounds the *write*, so it is sized against the
  seven-day window rather than "big enough to never evict". Evicting is safe because the mint, not
  this set, is what actually prevents a double-spend: an evicted fingerprint costs one round trip
  that fails safely. Oversized legacy sets are trimmed at load rather than on the first receive,
  which was a ~400ms stall at the counter.

- **The chunk-assembly map was unbounded in count.** The byte ceiling bounds one transfer; nothing
  bounded how many could be open at once, each holding decrypted fragments of someone's money for a
  10-minute TTL. Capped at 64, evicting the oldest, which costs a re-read and never a coupon.

## [0.6.0] - 2026-09-21

### Added

- **Issuance warrants are signed at Sell time and verified on receipt.** A voucher carries one
  signature and it is the issuing *service's*, so "stall X issued this" was an assertion nobody
  could verify against X. The wallet now signs a warrant binding a digest that **covers the face
  value** to the sale, and the merchant sees the warrant state at the till.

  A warrant attests a **sale**, not a voucher: one Sell mints an unknown number of coupons
  (quantity x server-side auto-split), so no voucher id exists at signing time. Verification is
  therefore a **ceiling** test rather than equality. Cross-language digest parity is pinned by
  `warrantDigestParity.test.ts` against vectors generated by the Java implementation.

- **Cash sales are reconcilable**: the warrant is stored on the row with its sibling voucher ids,
  and a customer cash attestation is signed at *receipt time* on the path that already runs.
  Attestations are verified before storage, so a poisoned row cannot displace the genuine one.

- **Cashback is warranted and reconciled.** It minted value with no warrant and was skipped by
  reconciliation entirely.

### Changed

- **A coupon without a warrant now fails validation.** While only *failed* warrants were refused,
  omitting a warrant was safer for an attacker than forging one.

### Fixed

- **Cashback signed as a fabricated owner actor.** The page built `{ kind: 'owner', stallPubkey }`
  by hand, which asserts owner-ness of whatever device is running - including a terminal, whose
  key is not the stall's - bypassing the guard meant to catch exactly that. Fail-safe, because the
  signer also compares its own pubkey against the stall, but the deliberate guard now does the
  work and both are pinned.

## [0.5.8] - 2026-09-18

### Fixed

- **Banners and coupon strips showed a blank band while they loaded.** The band was the right size,
  so nothing reflowed, but an empty grey rectangle asserts "this stall published no banner" — a
  different claim from "it is loading", and while the request is in flight, a false one. They now
  hold their space with a placeholder and fade in. A dead link still settles to the plain band
  rather than pulsing forever, because these URLs are self-published and dying is ordinary.

- **Your own profile page greeted you with your own npub.** `App` seeds its state with an empty
  profile and then awaits the relay, so on a first login — or any login after logging out, which
  wipes the device — the identity card printed the npub at the full weight a name gets. An account
  that has genuinely published no name still shows its npub: that is a settled answer, and the
  discriminator is whether anything has ever been written rather than whether a name is present.

### Changed

- Remote image loading is now one component (`RemoteImage`) rather than four copies of an `<img>`
  tag. It keeps the lazy and no-referrer rules those had, which are privacy controls and not
  tuning: fetching one of these hands the issuer the customer's IP and the moment they opened their
  wallet.
## [0.5.7] - 2026-09-18

### Changed

- **Relay reads no longer wait three seconds on a relay that is not there.** The same fault as
  0.5.6's profile fix, in the two reads that were left: `allAddressable` and `newestAddressable`
  query the relay and the gateway in parallel and merge the results, so the caller pays for the
  slower store. Reaching strfry from a browser needs its port published, which a real deployment
  does not do, and a socket to a host that DROPS packets ends on a timer rather than a refusal —
  so the ordinary deployed state was also the worst case. Measured: 3002ms uncapped against a
  black-holed address, 1201ms with the connection wait bounded, and 25ms either way to a healthy
  relay.

  These reads carry the merchant record and the issuance ledger, and a null answer takes away the
  merchant role, so the bound is deliberately gentler than the 150ms used for profiles: 1200ms is
  far above any healthy connect and far below the default. PUBLISHING IS NOT CAPPED — a read that
  gives up early costs a slower answer from the other store, while a publish that gives up early is
  an event the user believes they sent and nobody has.


## [0.5.6] - 2026-09-18

### Fixed

- **A profile that had not loaded yet was rendered as a truncated pubkey.** Avatars, display names
  and NIP-05s take time to arrive, and what stood in the gap was a hex key in the same type and
  position as a real name — indistinguishable from an answer to anyone reading a receipt. Places
  that are genuinely still waiting now show a loading placeholder instead. A lookup that came back
  EMPTY still shows the short key: that is a settled answer, not a wait, and a spinner that never
  resolves would be worse than the bug.

- **A failed lookup erased a name the device already knew.** Both profile hooks preferred the
  fetched record over the cached one, and a lookup that found nothing returns a defined-but-empty
  record — so a moment of bad signal put a hex key back over a stall the user had seen a hundred
  times.

### Changed

- **Profiles no longer wait for the relay to be read from nostrdb.** The kind-0 read awaited BOTH
  stores, so every lookup cost the slower one — and a browser WebSocket to an unreachable relay
  fails on a clock, not a packet: 3001ms to a host that drops, 4400ms with no EOSE, against 25ms
  for a healthy relay and 5ms for a refused connection. A deployment that does not publish strfry's
  port is the documented normal case, so nostrdb's answer sat complete in milliseconds while the
  browser counted down someone else's timeout. Both stores now get a 150ms budget and the newest
  answer within it wins; whatever arrives later still corrects what was shown, so the relay keeps
  overruling a frozen cache without anyone waiting for it.

- **Profiles are cached across sessions.** The cache was per-document, so every reload re-earned the
  same answers over the network. kind-0 is a replaceable event carrying its own `created_at`, so a
  stored copy is unambiguous — it is simply the newest this device has seen. A name already seen now
  renders on the first frame. Bounded at 200 records, oldest-written evicted first, since
  localStorage is a shared ~5MB quota.


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
