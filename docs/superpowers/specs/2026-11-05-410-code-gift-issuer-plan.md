# #410 code gifts: purchase-issuer plan (scoped, not built)

Status: plan. Owner decisions of 2026-11-05 on #515 apply. What IS built: payment-adapter#314 (draft,
pinning S/x/fresh R), imani-checkout-codes#11 (issuer deposits notify R), the mailer templates
(`gift-code`, `gift-code-return-link`, `gift-code-used`, `gift-code-expired`), the page copy (#515), and
a fail-closed guard: purchase-issuer parks any `gift: "code"` debt for a person BEFORE minting, so the
flags can never sell a code that is then minted as a voucher.

## Why this is bigger than the spec says

The spec says "mint the vouchers as today but lock each to S, with locktime x and refund to R, and arm
the pre-signed refunds at the relay". Two parts of that do not hold:

1. **The issuer cannot arm the refunds.** A pre-signed refund (`cashlinkFlow.refundSwap`) is a SIG_ALL
   witness **made with R's secret**, and the relay deposit is NIP-98 signed with the lock/link key. The
   owner's rule (and G-R3) is that R never leaves the buyer's browser except in their return link. So
   the issuer, which only ever sees R's *public* key, can mint the part (gateway `link_lock`, as G14 does)
   but cannot produce its refund. Options, each a decision:
   - (a) **No relay arm** for code gifts, as G14 already does for email gifts ("no refund is deposited at
     a relay: after x the buyer takes it back"). The buyer's return link takes the rest back after x with
     `settleLockedGift(noRelay: true)`. This needs no secret on the issuer. **Recommended.** It changes the
     task's "arm the pre-signed refunds at the relay" step, so it needs the owner's OK.
   - (b) The page seals R to the issuer (as it seals ℓ). This breaks G-R3 and the owner's "R reaches the
     buyer through the return link". Not recommended.
2. **The wallet's return page does not handle code parts after a rebalance.** `/gift-return#r=R` reads an
   `imani_gift_sent` wrap and settles THAT token. A code's parts are replaced by balance successors at the
   shop (#472). After a partial spend the original token is spent, and the remaining value sits in
   successor tokens the buyer has never seen. The return page must read `GET /v1/checkout-codes/mine` and
   `/{code}/parts` as R (enabled by imani-checkout-codes#11), then settle each unspent part after x. That
   is wallet work in `src/lib/lockedGifts.ts` / `GiftReturnPage.tsx`, not in the issuer.

The wire shape matters too. gateway `link_lock` mints `P2PK_VOUCHER(data=02‖lock, locktime, refund)`
with `sigflag SIG_ALL` (`verifyLockedGift`). Contract §2 requires that, plus `n_sigs 1` and the shop's
deposit checks (`StructuralPartVerifier.rawShape`: no `pubkeys`, `R ≠ S`, `R ≠ depositor`). This must be
confirmed against a real gateway mint locked to S (staging), because no fake can prove it.

## Plan (one imani-wallet PR, plus a small wallet PR)

1. `discharge.ts`: a `code` branch beside `email`. Lock = S (`delivery.shopKey`), refund = R, locktime =
   `delivery.codeExpiresAt` (pinned by payment-adapter; check `lockWindowProblem` against the coupon's
   expiry and NOW, else attention, nothing minted). Mint with `link_lock` under the same payment
   idempotency key and warrant nonce. `verifyLockedGift(token, {lockPubkey: S, refundPubkey: R, locktime: x})`.
2. `codeGift.ts`: deposit at `POST /v1/checkout-codes` as the issuer (NIP-98 by the seal key, which
   imani-checkout-codes lists in `CHECKOUT_CODES_ISSUER_DEPOSITORS`), idempotency key `<draftId>:code`,
   one part per minted token, `amount` = `creditableFaceValue`, `expires_at` = x. A replay answers the
   same code, so crash recovery is "re-mint (gc replays) and re-deposit (store replays)". 409
   `MINT_UNAVAILABLE` and 5xx stay pending (gift_undelivered, not parked). A 422 refusal is parked.
3. Mail the recipient `gift-code` (`<draftId>:code-mail`): amount, shop url, the code, x, and the
   balance link `<checkout-codes public base>/v1/code-check/{code}`. Then hand the buyer the
   `imani_gift_sent` wrap to R (the code's parts, for the return page), then scrub the seal (ℓ is unused
   for a code). New config: `PURCHASE_CHECKOUT_CODES_URL`, `PURCHASE_CODE_GIFTS=true`.
4. Buyer notices: the issuer cannot read R's NIP-17 notices (it lacks R). `giftTracker` gets a `code` row
   that polls the public `/v1/code-check/{code}` (status, remaining) and mails `gift-code-used` when
   `remaining` drops and `gift-code-expired` at x. No secret is needed.
5. Wallet: return page for code parts (point 2 above).
6. e2e: extend `e2e/gifting.e2e.ts` with fakes for the gateway mint (S-locked token), the code store
   deposit and code-check, and the mailer. Assert the deposit body, the idempotency keys, the `gift-code`
   fields, and a replay after a simulated crash.

Estimate: steps 1 to 4 and 6 are about the size of G14 (several hundred lines plus tests). Step 5 is a
separate wallet change. Needs the owner's call on 1(a) before starting.
