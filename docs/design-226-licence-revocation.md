# Design: seller revocation and the rest of #226 (imani-wallet#226)

Status: 2026-10-10. Builds on #197 (gc 0.25.0, portal 0.14.0, wallet 0.18.0 on staging).

## 0. What is already true

- gc issues every licence as `P2PK_VOUCHER`, `data = buyer`, `n_sigs = 1`, no `pubkeys`, no
  `refund`, FIXED (one proof, 1 sat backing).
- gc's licence verifier accepts only canonical P2PK licences from an allowlisted seller, locked
  (metadata `lock_key` == NUT-11 `data`) to the NIP-98 signer. Reissue and split refuse licences.
- The wallet (0.18.0) reads the NUT-11 `data` key (`mintLockKey`), and `verifyLicence` refuses
  `NOT_LOCKED_AT_MINT` and a `data` key that is not `lock_key`. `reportLicence` only offers P2PK
  licences. Nothing is missing there (section 3).
- So a copy is inert: B's wallet shows nothing (WRONG_KEY), the server refuses B's report
  (`LICENCE_WRONG_KEY`), and the mint refuses B's swap (no NUT-11 signature by A).

What is missing is the seller side of a refund: **the seller holds nothing it can spend.** After
the buyer's receive swap the seller's copy is already spent, and the buyer's fresh secret (re-signed
by gc with a new nonce) never leaves the buyer. gc stores only Ys, which are hashes.

## 1. Options for refund and revocation

### (a) Seller as a NUT-11 co-key (`pubkeys=[seller]`, `n_sigs=1`)

- **Does not work on its own.** Spending needs the CURRENT secret and C. The seller has neither
  after the buyer's receive swap, and gc cannot give them (it stores Ys only, by design, #197 §1).
- **Weakens theft resistance.** Any holder of the seller key (or a stolen seller nsec) can then
  spend every licence it ever sold, given a copy. That turns a seller-key leak into a way to destroy
  every customer's licence. Today a seller-key leak lets an attacker sell licences, not burn them.
- It also makes "the holder" two keys, which `LockAuthorization` and `SplitAuthorization` refuse to
  reason about (they would need a licence-specific exception).
- Rejected.

### (b) NUT-11 `refund` tag with `locktime = expires_at`

- Only usable **after** expiry, when the licence has already ended on its own. It does nothing for
  a mid-term refund, which is the case that matters.
- The seller still needs the current secret and C (same problem as (a)).
- All it buys is reclaiming the 1 sat of FIXED backing, which is not worth a new secret shape that
  the lock and split code would also have to learn.
- Rejected, including as an add-on to (c).

### (c) gc-side revocation by `subscription_id` (recommended)

The seller signs `POST /api/v1/wallet/licences/revoke {subscription_id, reason}` with NIP-98. gc
records it, and every licence of that subscription stops counting at once:

- **Who may call:** the NIP-98 signer must be in `GATEWAY_CUSTOMER_LICENCE_SELLER_PUBKEYS`, the
  allowlist that already decides who can sell. A NAP edge session is refused
  (`NIP98_REQUIRED`). A leaked edge secret forges `X-Auth-Pubkey`, so with it anyone could revoke
  every customer's licence. Real NIP-98 needs the seller's key.
- **Scope:** a revocation applies only to licences whose signed `issuer_id` is the revoking seller.
  With two sellers allowlisted, one cannot revoke the other's customers.
- **Effect:** in `licensedUntil` a revoked subscription's licences are skipped entirely: no end,
  and no grace from them. If the stall holds nothing else, the answer is a definite `null`. The
  portal writes `null`, and `TerminalLicenceGate` refuses at once, because the 72 h grace is applied
  only to a non-null `licensed_until`. So A's paid tills are 402 on the first refresh after the
  revocation (15 min on staging, 5 s on the gate). There is no portal code change, but a portal test
  now pins this.
- **Reports:** reporting a licence of a revoked subscription answers `422 LICENCE_REVOKED`. The
  wallet already treats any 422 as a verdict on that voucher and does not send it again.
- **Permanent, idempotent:** revoking twice changes nothing and answers the first `revoked_at`.
  There is no un-revoke endpoint. Undoing a mistake means re-issuing under a NEW `subscription_id`
  (the script's default for a new sale), which is also what a customer who comes back after a
  refund gets.
- **Before the report:** a seller can revoke a subscription gc has never seen (the licence is DM'd
  but not yet reported). The licence is then refused when it is reported.
- **Audit:** a `licence_revocation` row (`subscription_id`, `revoked_by`, `revoked_at`, `reason`)
  that is never updated or deleted, plus one `AuditLogger` event (`WALLET_OPERATION`,
  `operation=revoke_licence`, newly or already revoked, how many reported licences it hit) and an
  INFO line `licence_revoked_by_seller`. The reason is free text, capped at 200 characters, and
  control characters are stripped.
- **Theft resistance:** unchanged. The licence itself is unchanged, and the seller key gains no
  spending power. A stolen seller key can now revoke licences, but it could already sell
  unlimited free licences. Revocation is a denial of service, not a grant, and every revocation is
  audited by signer.

Why (c) fits: the server is already the authority (#197, ADR 0007). It is the only party that
knows which stall a licence counts for, and the mint was never going to learn about refunds.

### SPENT stays as it is

A licence the mint says is SPENT (theft by someone who got the buyer's secret and C, or the buyer
burning their own) still ends at `revoked_at` and keeps the portal grace (D3 of #197). Seller
revocation is the deliberate act, and it has no grace.

## 2. API

```
POST /api/v1/wallet/licences/revoke          NIP-98 by an allowlisted seller
{ "subscription_id": "sub_9f2c…", "reason": "refund 2026-10-10" }

200 { "subscription_id", "revoked_at", "already_revoked": false|true, "reported_licences": n }
400 INVALID_SUBSCRIPTION_ID | INVALID_REASON
401 (no NIP-98)    403 NIP98_REQUIRED (edge session)    403 NOT_A_LICENCE_SELLER
```

Rate limit: `/api/v1/wallet/licences` 10/min per pubkey.

Seller command: `node scripts/sell-subscription.mjs --revoke sub_… --reason "…" [--env-file …]`.
It signs with the seller key (env or `--env-file`, value never printed) and marks the row in
`.sold-subscriptions.json` as revoked, so `notify-expiring.mjs` stops sending reminders for it.

## 3. Wallet parser and verifyLicence (item 2)

Checked on 0.18.0 (`cb0a317`):
- `licenceOf` returns `mintLockKey` from the P2PK `data` (`signed.lockKey`).
- `verifyLicence` refuses `NOT_LOCKED_AT_MINT` (plain VOUCHER) and `WRONG_KEY` when
  `xOnly(data) != lock_key`. It also refuses `WRONG_KEY` when `lock_key != presenter`, and
  `NOT_SOLD_BY_US` when the seller is pinned.
- `reportLicence` skips non-P2PK licences.

Nothing is missing. One gap remains, and it is a UI one, not security: after a seller revocation,
the buyer's wallet still SHOWS the licence as valid (it verifies locally) while the server refuses
it. The wallet is not the boundary (ADR 0007). Follow-up: show "revoked by the seller" when the
report answers `LICENCE_REVOKED`.

## 4. Migration (item 3)

A plain-VOUCHER licence now licenses nothing (`NOT_LOCKED_AT_MINT`, server and wallet).

Staging, read-only SELECTs on 2026-10-10 (`default_transaction_read_only=on`):

| Where | Count |
|---|---|
| `imani_customer.stall_licence` (every licence ever reported) | 0 |
| `imani_portal.stall_licence_state` | 0 |
| `received_token_dm` with a subscription/licence memo | 0 |
| `received_token_dm` / `dm_token_inbox` from the allowlisted seller `62dd912f…` | 0 / 0 |
| `received_token_dm` / `dm_token_inbox` from "Rosa Green Farm" `7952939535a7…` | 0 / 0 |
| `cashu_mint.voucher_quote` by the seller or by Rosa, or `face_value=4000` GBP | 0 |
| `received_token_dm` on 2026-09-03..05 at all | 0 |

So **staging holds no licence of either kind.** The known sale of 2026-09-04 is in the seller's
local ledger (`imani-wallet/.sold-subscriptions.json`, written 09:37 BST): `sub_bdfa6692f475a40f`,
customer `4728fd8a…` (the `demo-customer` seed key), annual, 4000 GBP, `expires_at: null`. The
script at that commit (`0d74395`) defaulted to `WALLET_URL=http://localhost:28082` and
`PROPORTIONAL`. The sale was signed by the "Rosa Green Farm" seed key. So it was a plain or
unexpiring licence from a seller that is not on the allowlist, minted on a local stack. Under #197
it fails three checks: `NOT_SOLD_BY_US`, `NOT_LOCKED_AT_MINT`, `NO_EXPIRY`. The 2026-09-04 wallet
would already have refused it as `NO_EXPIRY`.

Re-issue path for any existing buyer (this one included), run by the owner:

```
WALLET_URL=https://wallet.staging.398ja.xyz node scripts/sell-subscription.mjs \
  --env-file ../imani-deploy/.env.staging \
  --customer-pubkey <the buyer's stall pubkey> --paid 4000 --currency GBP \
  --subscription-id sub_bdfa6692f475a40f      # same relationship, receipt kept
```

This mints a FIXED P2PK licence, locked to the buyer, from the allowlisted seller, and DMs it. The
buyer's wallet reports it on the next dashboard or Terminals visit. Confirm the buyer's key first
(the ledger has a seed key, which may not be the real customer's stall). Production: run the same
SELECTs (section 4 of the PR) on prod before the wallet that reports ships.

## 5. Acceptance (item 4) and where each is proven

| Requirement | Proof |
|---|---|
| A licence bought by A and sent to B: B's wallet shows no licence | `verifyLicence` WRONG_KEY (unit, wallet), gate check "B's wallet sees no licence in A's copy" |
| The server refuses B's report | gate: B reports A's secrets → 422 `LICENCE_WRONG_KEY`; gc IT `anotherStallReportingACopiedLicenceIsRefused` |
| B can't swap it at the mint | gate: swap A's proofs with B's key → mint refuses, NUT-07 still UNSPENT |
| A keeps working | gate: A's T2 still 201 after B's attempts |
| The seller revokes A's licence, and A's paid tills drop to 402 within one re-check | gc unit and IT, portal gate test, gate: seller `--revoke` → T2 402 after one refresh period (no grace wait), T1 still 201, A's re-report 422 `LICENCE_REVOKED` |
| Only the seller can revoke | gc unit and IT: a non-seller gets 403, an edge session gets 403 `NIP98_REQUIRED`, and seller X cannot revoke seller Y's |
