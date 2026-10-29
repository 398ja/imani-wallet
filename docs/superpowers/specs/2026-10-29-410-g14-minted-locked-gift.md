# #410 G14: a gift minted locked (contract shared by three lanes)

Owner decision G14 (2026-10-29, ADR 0016): a gifting-site handle or email gift is
**minted already locked** by gateway-customer, at issuance, for the Purchase Issuer
(which holds the stall's terminal credential, never `R`). No burn, no `/cashlink/lock`,
no refund relay deposit. After `x` the buyer takes it back.

## 1. Issuance request (gateway-customer, `POST /api/v1/wallet/vouchers`)

Today `merchant_metadata.lock_key` (or `recipient_pubkey`) mints
`P2PK_VOUCHER(data = lock_key)`. New, optional, top-level field on the create request:

```json
"link_lock": { "refund_pubkey": "<64 hex x-only, or 66 hex compressed>", "locktime": 1850000000 }
```

Allowed only together with a lock key (`recipient_pubkey` or `merchant_metadata.lock_key`), and
never on a terminal credential or licence (`terminal`, `subscription_id` in metadata): 400
otherwise. When present, EVERY minted proof's secret is exactly the shape
`LinkLock.shapeProblem` accepts and `cashlinkLock.ts` `readLinkLock` reads:

```
["P2PK_VOUCHER", { "nonce": <fresh per output>, "data": <lock key, compressed>,
  "tags": [ voucher terms..., ["locktime", "<x>"], ["refund", "<R compressed>"],
            ["sigflag", "SIG_ALL"], ["n_sigs", "1"]?, ["max_sats", "<this proof's amount>"],
            ["issuer_sig", ...], ["issuer_pubkey", ...] ] }]
```

- no `pubkeys` (no co-key), `n_sigs` absent or 1, `n_sigs_refund` absent or 1;
- `refund` x-only != lock key x-only (400 `REFUND_IS_LOCK_KEY`);
- `locktime` passes `LinkLock.timingProblem` against the coupon's own `expires_at`, at
  request time (400 with the problem name: `LOCKTIME_IN_PAST`, `LOCKTIME_TOO_NEAR`,
  `LOCKTIME_TOO_FAR`, `LOCKTIME_TOO_CLOSE_TO_EXPIRY`);
- never a locktime without a refund key (the hard rule, cashu-mint#566);
- `max_sats` per output is stamped by the existing per-output `boundedToOwnAmount` (it already
  stamps any locked secret), and the issuer signature covers it (resigner per output);
- the issuer signature covers `locktime`, `refund`, `sigflag` too (signed after they are set);
- idempotency and warrant behaviour unchanged; the field is copied through
  `VoucherController` rebuild (CreateVoucherRequestCopyTest) and persisted in the recipe
  (`PendingVoucher`, `RecipeJson`) so a resumed finalisation mints the same shape.

The resulting proof is then claimable by `POST /api/v1/wallet/vouchers/cashlink/resign`
exactly as a `/cashlink/lock`-made one (link key's way before or after `x`, refund key's way
after `x`). That route must accept it: it needs `max_sats` + DLEQ (present), `OurIssuance`
(issuer = this gateway's identity key), not a credential. Its legacy-budget release finds no
reservation row for these and releases nothing, which is correct.

## 2. purchase-issuer (imani-wallet `services/purchase-issuer`)

For `gift.kind`:

- `handle`: lock key = the pinned `recipientPubkey`; `refund_pubkey` = `delivery.refundPubkey`;
  `locktime` = `claimWindowEnd(mintedAt, claimWindowDays, couponExpiry) / 1000`, refused
  before minting when `windowTooShort`. Delivered by DM to `recipientPubkey` exactly as today
  (`/api/v1/dm/tokens/send`), payload type unchanged (`cashu_token_transfer`).
- `email`: `openSeal(...)` gives `ℓ`; lock key = `getPublicKey(ℓ)`; same `refund_pubkey`,
  `locktime`. Delivered as the Cashlink the wallet's `/g` page reads: a NIP-17 gift wrap to
  `L` whose rumor content is `{"type":"cashu_token_transfer","token":...}` (exactly
  `cashlinkFlow.wrapForLink(ℓ, token)`), published to the gateway relay endpoint
  (`POST /api/v1/nostr/events`, NIP-98 by `ℓ`), confirmed by querying it back. Then the
  claim email via imani-mailer `gift-claim` template with the wallet's link format
  (`formatGiftLink(walletOrigin, ℓ, x)`: `<origin>/g#v=1&k=...`), then scrub the seal.
- discharge only after the voucher exists locked AND (handle) the DM is accepted, or (email)
  the wrap is confirmed stored AND the mailer accepted the email. Idempotent on the draft /
  payment intent: a retry re-mints under the same idempotency key (same token back) and
  re-delivers the same wrap/email (mailer idempotencyKey `<draftId>:claim`).

## 3. Wallet (imani-wallet `src/`)

- Recipient, email: `/g#v=1&k=` claim already works for any `readLinkLock` proof on the link
  (`claimLockedGift`). Pin with a test using a minted-locked proof.
- Recipient, handle: a `P2PK_VOUCHER` proof that `readLinkLock` reads with `linkPub` = this
  wallet's own key, arriving by DM: dm-poll must CLAIM it (re-sign route, link key's way,
  signed with the wallet's own key) into an unlocked coupon, before `x`, and show
  "Claim by <date>" if it cannot yet. Never store it as plain spendable money.
- Buyer take-back. The buyer needs the LOCKED token to take it back. It is not a claim link
  (G8): before `x` only the lock key can spend it, after `x` the lock key or `R`, so holding it
  gives nothing to anyone without `R`. The Purchase Issuer hands it to the buyer after delivery:
  - signed-in buyer (`refund` = the buyer's wallet key): a NIP-17 DM to the buyer
    (`/api/v1/dm/tokens/send` is token-only, so the issuer sends the wrap itself via
    `/api/v1/nostr/events`, kind 1059 to the buyer) with rumor content
    `{"type":"imani_gift_sent","v":1,"token":<locked>,"stall":<name>,"to":<display>,"claimBy":x}`.
    dm-poll records it as an outgoing gift (never as balance: it is not the buyer's to spend
    before `x`), shows it in Activity ("Sent to bob@…, claim by <date>"), and after `x`, if the
    proofs are still unspent, takes it back: refund-key swap (witness by the wallet's own key)
    into derived outputs, then `/cashlink/resign` by the refund key, keep the coupon. Spent
    before `x`: claimed. Lane owns the derivations (reuse `cashlinkFlow.settleLockedGift`
    with refundSecret = the wallet key; it needs linkSecret only for the before-x path, which
    the buyer never takes; pass a dummy-free variant).
  - guest (decided in the purchase-issuer lane, least custody): the issuer does NOT hold `R`
    and never puts a token in an email. It sends the guest the SAME `imani_gift_sent` NIP-17 wrap,
    p-tagged to the refund key `getPublicKey(R)`, signed by its seal key (pubkey at
    payment-adapter `GET /api/v1/gifting/issuer-key`). The guest's return link is the one the
    gifting SPA already shows, `<walletOrigin>/gift-return#r=<R hex>` (made in the browser, never
    sealed, never sent to a server). The wallet's `/gift-return` page reads `r`, queries kind 1059
    with `pTags=[getPublicKey(R)]` (NIP-98 by `R`), unwraps the token with `R`, shows the gift and
    its state (NUT-07), and after `x` (never before) takes it back, same mechanics with R = `r`.
    An optional `&t=<locked token>` in the fragment is accepted but nobody needs to send it. One
    delivery path covers both buyers: the wrap goes to the refund key, whoever holds it. Rejected:
    an issuer email with `#t=` (a token in a mailbox, and a second link the guest must pair with the
    first) and sealing `R` (G-R3).
  - Before `x`, neither buyer can take it back (no `ℓ`). Copy: "You can take it back after
    <date> if it isn't claimed."
