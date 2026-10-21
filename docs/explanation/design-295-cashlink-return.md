# Design: an unclaimed Cashlink comes back on its own (imani-wallet#295)

**Status:** Proposed, 2026-10-21. Investigation and design only. Nothing is implemented.
The owner decides the approach (section 7) before any code is written.
**Kind of document:** Diátaxis *explanation*. It argues for a design and says plainly what the
design does not solve. A reference section (section 8) lists the changes by repo.
**Issue:** [398ja/imani-wallet#295](https://github.com/398ja/imani-wallet/issues/295).
Related: #268 (Cashlink), #271 (phase 1), `docs/spec-claim-links.md` §2 (iv), §3.3, §6,
ADR 0001 and 0002 (self-custody), cashu-mint#540 (redemption cap, D9, D10, D11),
cashu-voucher#59, imani-gateway-customer#136.

Code references are `repo:path:line` against these heads, taken on 2026-10-21:

| Prefix | Repo | Ref |
|---|---|---|
| `wallet:` | imani-wallet | `origin/main` dac97a8 (0.36.0) |
| `mint:` | cashu-mint | `origin/master` 434f14fe (0.44.2) |
| `lib:` | cashu-lib | `origin/main` f02ce44 |
| `voucher:` | cashu-voucher | `origin/main` e6e1152 (0.17.0) |
| `gc:` | imani-gateway-customer | `origin/main` a698ce3 (0.31.2) |
| `core:` | imani-gateway-core | `origin/main` 0ce70c4 |
| `wlib:` | imani-wallet-lib | `origin/main` f46ca53 (0.9.4) |

Shortened paths: `mint:…/validator/X.java` is
`cashu-mint-protocol/src/main/java/xyz/tcheeric/cashu/mint/proto/tasks/validator/X.java`;
`gc:…/voucher/X.java` is `gateway-customer-rest/src/main/java/xyz/tcheeric/gateway/customer/voucher/X.java`.

---

## 0. Summary

1. **NUT-11 does not make the link key stop working at `x`.** Locking the gift to the link key
   with `locktime = x` and `refund = sender` adds a second way to spend after `x`. It does not
   remove the first. The spec says so, and our mint implements it exactly that way
   (`mint:…/validator/P2PKSpendingCondition.java:61-66`: the primary path is accepted "at ANY
   time, before or after the locktime"). So option 1 on its own gives "the sender can also
   spend after `x`", **not** "the mint refuses a claim after `x`". The race the issue says
   "goes away" is still there.
2. **The key insight: the refund can be signed in advance, and then anyone can run it.**
   With `sigflag = SIG_ALL`, the sender's refund signature covers the exact outputs. At link
   creation the sender's wallet builds the refund swap with **plain outputs blinded by the
   sender**, signs it with a refund key, and hands it to a relay. After `x` the relay posts it to
   the mint. The relay holds nothing it can spend: it cannot run the swap before `x` (the mint
   refuses the refund path), cannot change the outputs (SIG_ALL), and cannot unblind what comes
   back (it never has `r`). Once that swap lands, the gift proofs are SPENT, so **from then on the
   mint does refuse a claim**. That is option 2 made compatible with ADR 0001.
3. **What cannot be pre-signed is the voucher itself.** The refund outputs must be plain sats.
   A voucher output needs an issuer signature over a fresh secret, and a signed voucher secret
   made before its predecessor is burnt is a free-standing coupon that can be minted from any
   sats: the face-value printer that imani-gateway-customer's re-sign route exists to prevent
   (`gc:…/voucher/VoucherReissueService.java:280-288`). So the return is two steps: the relay
   pulls the value off the link at `x` (no sender involvement), and the sender's wallet turns
   the sats back into the voucher through the existing re-sign route the next time it runs (app,
   or API). Both steps are recoverable from the seed.
4. **Strict expiry needs one more piece.** Between `x` and the relay's swap, a late claim can
   still win. Closing that window exactly needs either a claim co-signer that refuses after `x`
   (standard NUT-11, a server holding half a 2-of-2) or an Imani extension to `P2PK_VOUCHER` that
   switches off the main path after `locktime` (a mint change). Section 5 compares them. The
   recommendation is to ship the bounded window first and decide the strict form separately (Q2).
5. **Background execution on the device (option 3) does not work for this wallet.** There is no
   iOS project, the Android app has no background runner, the web app has none, and the key is
   passphrase-encrypted at rest, so nothing can sign while the app is closed. The pre-signed
   refund is what removes the need to sign at `x` at all.
6. **Option 1 is a larger change than the issue suggests.** Today a gift is an unlocked, bearer
   `VOUCHER`. Locking it means a new issuer re-sign in imani-gateway-customer (bearer to
   link-locked, adding `locktime`, `refund` and `sigflag`), a new reissue rule for predecessors
   that carry a refund path (today refused outright, `gc:…/voucher/LockAuthorization.java:71-77`),
   and a claim that becomes a wallet-side burn plus re-sign, which runs into **D9** (cashu-mint#540).
   Phase 0 (counting fix, reconcile before send, API status, docs) ships without any of that.

---

## 1. How it works today

### 1.1 A gift link

From `wallet:src/lib/giftLinks.ts` and spec §3.3:

- **Send** (`sendGift`, `:214-275`): derive a link key `linkSecret_i = HMAC(identity, "imani-gift-link/v1/" || i)`
  (`:101-115`), check the relay has nothing at that index (`unusedLink`, `:132-155`), then run the
  ordinary atomic send to `linkPub`. gateway-core splits the coupon and gift-wraps the **bearer**
  send token to `linkPub`. The row keeps `link: {k, i, x, status: 'outstanding'}`.
- **What is on the link:** an unlocked `VOUCHER` token. The picker refuses locked coupons
  (`wallet:src/lib/giftLink.ts:507-522`, exclusion `'locked'`), so a gift is always bearer.
- **Claim:** the recipient unwraps with `k`, verifies, then receives through
  `TokenRedemption.redeem(token, {source: 'gift_link'})`, which is gateway-customer's
  `POST /api/v1/wallet/receive` (`giftLinks.ts:315-391`).
- **Reclaim:** the sender does the same receive with `source: 'gift_link_reclaim'`. It is a race
  at the mint with any claim: first swap wins.
- **When reclaim runs:** only in `reconcileGiftLinks` (`:449-492`), called at start-up after
  `restoreScan` (`wallet:src/App.tsx:335-341`) and when a Cashlink row is opened
  (`wallet:src/components/GiftLinkSection.tsx:31`).
- **The limit:** `MAX_OUTSTANDING_LINKS = 10` (`:44`), counted by `status === 'outstanding'`
  (`:239-241`), and a status changes only inside a reconcile or a take-back.

### 1.2 The gaps #295 names, confirmed

| Gap | Where |
|---|---|
| Nothing returns a link unless the app runs | `reconcileGiftLinks` has exactly two callers, both UI |
| `x` is advisory | Only the recipient's wallet checks it (`giftLink.ts:397-410`). The token is bearer, so the mint has no idea `x` exists. |
| Expired links block new ones | `sendGift` counts `outstanding` rows and does not reconcile first (`giftLinks.ts:239-241`) |
| The docs over-promise | `wallet:docs/customers.md:172-174`: "your wallet takes the coupon back the next time you open it" is true; the employer pitch's "unclaimed gifts come back to you" is not |
| The API cannot help | `wallet:services/wallet-api` has no Cashlink endpoints at all (grep for `gift_link` finds none) |

---

## 2. Option 1 checked against NUT-11 and our code

### 2.1 What NUT-11 says about the main key after `locktime`

From [NUT-11](https://github.com/cashubtc/nuts/blob/main/11.md), "Locktime Tag" and "Refund MultiSig":

- `now <= locktime`: the lock is **active**; only the main pathway (`data` plus `pubkeys`) applies.
- `now > locktime`: the lock has **expired**. "Both Locktime Multisig and Refund Multisig
  conditions apply if the `refund` tag is present, otherwise the proof is considered unlocked."
- Refund MultiSig: "Locktime Multisig conditions **continue to apply**, and the proof can continue
  to be spent according to Locktime Multisig rules. **In addition**, the Proof can be spent if a
  valid signature is given by at least ONE of the public keys contained in the refund tag."

So after `x` **either** the link key **or** the refund key can spend. NUT-11 has no way to say
"the main key stops at `locktime`".

### 2.2 What our mint does

`mint:…/validator/P2PKSpendingCondition.java:58-87`, in order:

1. Primary path satisfied: accept. **Any time**, before or after the locktime (comment at `:61-62`).
2. Primary path not satisfied and locktime not passed: refuse.
3. Locktime passed and **no refund keys: accept with no signature at all** (`:76-79`), as NUT-11
   says. This is pinned for `P2PK_VOUCHER` too:
   `mint:…/proto/spending/P2PKLocktimeUnlockTest.java:81` *"aP2PKVoucherWithAPastLocktimeAndNoRefundKeysWouldAlsoBeUnlocked"*.
   A link-locked gift that ever lost its `refund` tag would become anyone-can-spend at `x`.
4. Otherwise the refund keys must meet `n_sigs_refund`.

`locktimeHasPassed` is `locktime > 0 && locktime < now` in seconds (`:120-140`).

**Answer to "is 'the mint refuses a claim after `x`' achievable with option 1?":** not by the lock
alone. Option 1 only makes the refund *possible* after `x`. The mint refuses a claim after `x`
only once something has actually spent the gift through the refund path. Whoever does that, and
how promptly, is the whole of the remaining problem (section 3).

### 2.3 Does our mint run NUT-11 locktime and refund on VOUCHER keysets?

There are no separate voucher keysets: voucher proofs use the standard keyset keys
(`mint:…/validator/VoucherSpendingCondition.java` class comment; `SwapTask.java:423`). What
matters is the secret kind:

| Kind | Condition | Locktime and refund |
|---|---|---|
| `VOUCHER` (what a gift is today) | `VoucherSpendingCondition` only | **Not applicable.** No witness is ever checked. An unlocked voucher cannot carry a lock (ADR 0008). |
| `P2PK_VOUCHER` | `P2PKVoucherSpendingCondition`: the voucher checks, **then** `P2PKSpendingCondition` (`:121-130`) | **Yes, by delegation.** The P2PK half is the same class plain P2PK uses, built with the whole transaction so `SIG_ALL` works (`VerifyProofsTask.java:199,220`). |

So the mint needs **no code change** for the locktime/refund semantics on `P2PK_VOUCHER`.
What is missing is **test coverage**: no mint test spends a `P2PK_VOUCHER` through the refund
path, or with `SIG_ALL`. The only locked-voucher locktime test is the "no refund keys means
unlocked" hazard above. Phase 1 adds those tests before anything relies on them.

Three properties that shape the design:

- **The voucher's own expiry still applies to the refund.** `VoucherSpendingCondition` refuses an
  expired voucher on every path (`:132-138`). If the coupon expires before the refund runs, the
  value is gone for everyone. So `x` must sit well inside the coupon's own `expires_at`
  (`giftExpiry` already clamps `x` to the coupon expiry, `giftLink.ts:165-173`; it needs a margin).
- **`SIG_ALL` needs identical tags on every input** (`P2PKTransaction.java:90-105`). Every proof
  of a voucher carries its own `issuer_sig` and its own `max_sats`, so two proofs of one voucher
  never have identical tags. **A `SIG_ALL` refund is one swap per proof.** That is fine (a gift
  is a handful of proofs) but it must be designed in.
- **A voucher input may swap to plain outputs.** The mint refuses only mixed *inputs*
  (`SwapTask.java:512-534`) and requires the totals to match (`:544-549`). "Swap back to sats"
  already does this in production, sending no declaration (`wallet:src/lib/swapBack.ts:20-45`).

### 2.4 Does the issuer path accept a link-locked voucher with a refund key?

No, not today. Three separate refusals in imani-gateway-customer:

| Step | Today | Why it refuses |
|---|---|---|
| Turn the bearer gift into `P2PK_VOUCHER(data = linkPub, locktime, refund)` | No route does this | `VoucherReissueService.reissue` needs **both** secrets to be `P2PK_VOUCHER` (`:196-201`). A bearer `VOUCHER` predecessor is `NOT_A_LOCKED_VOUCHER`. |
| Add `locktime`, `refund`, `sigflag` to a successor | Refused | `VoucherTerms.MUTABLE_TAGS` is an allowlist of `issuer_sig`, `issuer_pubkey`, `max_sats` (`VoucherTerms.java:47-50`). Its comment names `locktime`, `refund`, `pubkeys`, `n_sigs`, `n_sigs_refund` and `sigflag` as the tags that decide who can spend, and keeps them immutable on purpose. |
| Re-sign a predecessor that **has** a refund path (the recipient's claim, or the sender's return) | Refused | `LockAuthorization.isAuthorisedBy` returns false for any predecessor with `pubkeys` or `refund` (`:71-77`): "which of them may re-lock the coupon is a policy nobody has decided." |

The other guards hold unchanged and must keep holding on any new route: only our own issuance
(`OurIssuance.java:41-46`), the predecessor's signature verifies first, the burn bound (sign only
after the mint says SPENT, `BoundedVoucherReissue.java:68-97`), one signature per burn (the claim
ledger), the successor sat bound (#141), and no licence or credential (`:258-264`).

**Does locking break redemption?** The recipient must not end up holding a coupon still locked
to the link key with the sender's refund on it, or the sender could take it back from the
recipient's wallet after `x`. Today's receive would do exactly that:
`wlib:…/H2WalletService.java:2337-2346` re-nonces a `P2PK_VOUCHER` and keeps `data` and every tag.
So the claim must **re-lock** to the recipient and drop the refund path. After that:

- **Stalls, the till and payment requests:** a `P2PK_VOUCHER` locked to the customer is the
  shape purchased coupons already have (#58). It spends with the customer's witness through
  `X-Cashu-Witnesses` (`gc:…/witness/WitnessHeaders.java`). One known limit carries over:
  gateway-core cannot split a locked voucher in a send (`core:…/voucher/LockedVoucherSplitRequiresHolderException.java`),
  and with `force-swap-on-no-swap-branch` on it cannot send one at all (`LOCKED_VOUCHER_SEND_FORCED_SWAP`).
  A gift recipient would inherit that, where today they hold an unlocked coupon (Q4).
- **#540 cap:** `VoucherTerms.of` reads `P2PK_VOUCHER` tags (`mint:…/voucher/VoucherTerms.java:42-62`),
  so the per-voucher cap and the declared-redemption header work unchanged on the final coupon.
  The refund swap and every re-lock declare nothing, like a gift split and like swap-back (D11).
- **Merchant only own vouchers:** unaffected. The wallet refuses before any swap
  (`giftLinks.ts:323-333`) and gc refuses `FOREIGN_VOUCHER_FOR_MERCHANT` on receive.

### 2.5 How the recipient would claim a link-locked gift

The link secret is the private key for `data`. Because the refund must be `SIG_ALL` (section 3.2),
the claim must be `SIG_ALL` too: there is one `sigflag` per secret. So the link key must sign over
the exact outputs, which rules out today's claim through gc's receive, where gc chooses the
outputs and the wallet sends per-secret witnesses in a header.

The claim becomes the re-lock protocol that already exists and is proven against the live stack
(`wallet:src/lib/__tests__/reissueProbe.test.ts`, `wallet:src/lib/voucherReissue.ts`):

1. **Burn.** One swap per gift proof at the mint: input the gift proof with a `SIG_ALL` witness by
   the link key; outputs plain, blinded by the recipient. The intent is persisted first
   (`wallet:src/lib/receiveSwap.ts`), so a lost response is recoverable.
2. **Re-sign.** `POST /api/v1/wallet/vouchers/reissue` with a successor locked to the recipient
   and **without** `locktime`, `refund` or `sigflag`, authorised by the link key (needs the new
   rule in section 3.4).
3. **Mint** the successor from the plain proofs the burn produced.

That is a wallet self-swap of a voucher, which **D9 forbids until R1 or shape A**
(cashu-mint#540: "the wallet self-swap for vouchers must not ship before R1 or shape A. A
self-swapping till holds no token, so it is an undeclared redeemer"). A customer claiming a gift
credits nobody, so it is arguably outside D9's reason, but D9 is worded for every wallet voucher
self-swap and only the owner can narrow it (Q3). The one real D9 case is a stall opening a gift
of its **own** coupon, which today declares a redemption through gc's receive (spec §3.2). Under
this design that path would have to stay on gc or be refused.

---

## 3. Who performs the refund

### 3.1 The constraint

ADR 0001: the API "holds **neither** the customer's key nor their coupons", because "a breach of a
custodial wallet API is a theft". ADR 0002: the service "has **no code path capable of
spending**". Any sweeper must keep that property: a full breach of it must be at worst a denial.

Against a bearer gift (today) that is impossible. Anything able to reclaim a bearer token can also
claim it, at any time, for itself. So option 2 without option 1 is rejected outright, as the
issue expected.

### 3.2 Pre-signed refund: the design that keeps self-custody

At link creation, while the sender is in the app anyway, after the gift is locked to
`P2PK_VOUCHER(data = linkPub_i, locktime = x, refund = [R_i], sigflag = SIG_ALL)`:

1. **Derive** a refund key `R_i = HMAC(identity, "imani-gift-refund/v1/" || i)` (a dedicated key,
   not the identity key, so a leaked refund signature reveals nothing reusable), and for each gift
   proof `j` the plain output secrets `s_ij` and blinding factors `r_ij`, also from the identity
   by HMAC with their own labels. Deterministic, so a restored wallet can rebuild them
   (section 4.2). A remote-signer account uses random values kept in the encrypted history record,
   as it already does for link secrets (`giftLinks.ts:77-88`).
2. **Build** one swap per gift proof: input the proof `(secret, C)`, outputs the plain blinded
   messages `B_ij = hash_to_curve(s_ij) + r_ij·G` in the active keyset, amounts summing to the
   proof (voucher swaps carry no fee, `SwapTask.java:317-322`).
3. **Sign** each with `R_i` over the NUT-11 `SIG_ALL` message
   (`secret || C || amount_0 || B_0 || …`, `mint:…/validator/SigAllMessage.java`). The mint checks
   it only at spend time, so a signature made before `x` is valid for a swap posted after `x`.
4. **Deposit** `{proof, outputs, witness, x}` with a refund relay. Nothing else.

**Why the relay cannot steal, case by case:**

| The relay tries to | The mint says |
|---|---|
| Post the refund before `x` | Refused: the refund path is closed while `now <= locktime` (`P2PKSpendingCondition.java:69-72`) |
| Swap the outputs for its own | Refused: `SIG_ALL` covers every `B_` and amount |
| Use the witness on another proof | Refused: the message covers that proof's `secret` and `C` |
| Claim the gift through the main path | Needs the link key, which the relay never has |
| Unblind the returned signatures | Impossible: `C = C_ − r·K` needs `r`, which never left the sender |

The worst a compromised relay can do is not post (the wallet still takes the gift back itself,
as today) or post late. It also learns the gift's `Y`s, amounts and `x`, which is the privacy
cost to weigh (section 6).

**Is a voucher pre-sign possible instead of sats?** No. The refund's outputs would have to be
issuer-signed voucher secrets made before the gift is burnt. The mint never sees output secrets,
so such a secret could be minted later from any voucher sats of the same amount while the gift is
also claimed: two coupons from one. The re-sign route signs only after the predecessor is SPENT
for exactly this reason (`VoucherReissueService.java:268-288`, "one burn produced three valid
signatures over three distinct lock keys"). So the relay returns **sats**, and the voucher is
re-formed afterwards.

### 3.3 Turning the sats back into the voucher

After the relay's swap, the gift proofs are SPENT by a witness from `R_i`, and the sender holds
(unknowingly) plain blind signatures only it can unblind. On the sender's next run, app or API:

1. Get the blind signatures: from the relay (it keeps the mint's response), else by NUT-09
   `POST /v1/restore` with the re-derived `B_ij` (`mint:cashu-mint-rest/…/CashuController.java:563`).
2. Unblind with `r_ij`. These are now plain proofs in the sender's wallet.
3. Re-sign: `reissue` with predecessor = the gift secret, successor = locked to the sender (or the
   original coupon shape, Q4), authorised by `R_i` (section 3.4).
4. Mint the successor from the plain proofs, exactly as `reissueProbe.test.ts:205-209` does.

If step 3 is ever impossible (gc down for good, issuer key rotated), the sender still holds the
coupon's backing as plain sats, which is the same floor as "Swap back to sats".

### 3.4 One new rule for re-signing a predecessor with a refund path

Who may ask for the one re-signature of a gift proof once it is spent? Today's rule ("the key in
`data`") is wrong here twice: after the relay's refund, `data` is the link key, which the
recipient (and anyone who saw the link) holds. They could ask first, win the one signature for a
successor locked to themselves, and mint it from their own sats, leaving the sender with plain
sats only. That is #136 again.

**Rule: the key that spent it decides.** NUT-07 returns the spending witness for a spent proof
(`mint:…/tasks/CheckStateTask.java:72-76`), and the mint stores it (`MintProtocolUtil.java:199`).
gc already asks the mint whether the predecessor is SPENT. It reads the witness on the same call,
checks which pathway signed (`data`/`pubkeys` or `refund`), and requires the `lock_authorization`
from that same pathway. A link-key spend can be re-locked only by the link key (the recipient's
claim). A refund spend can be re-locked only by `R_i` (the sender's return). No race at `x`: the
mint's own record of the spend decides.

### 3.5 What triggers the relay, and where it lives

| Host | For | Against |
|---|---|---|
| **imani-gateway-customer** (recommended) | Already talks to the mint, has a database and scheduled jobs, already NIP-98 | Must never attach its redeemer token to these swaps (it is a crediting redeemer under #540). A separate client, tested like the D9 guards. |
| imani-cashback-claim | Already an escrow with expiry sweeps | Its depositor is one bearer token (the portal); spec §3.1 already rejected it for customer gifts |
| A new tiny service | Cleanest blast radius | Another thing to deploy and watch |
| Public, on a relay (anyone may post) | Maximum decentralisation: the swap only ever pays the sender | Publishes every gift's `Y`s, amounts and expiry |

Deposits are NIP-98 signed by the **link key**, not the sender's identity, so the relay does not
learn who sent what. A deposit is idempotent per proof. The relay posts at `x + 60 s`, retries on
5xx, treats "already spent" as final (claimed, or the sender took it back), and keeps the mint's
response until the sender fetches it or the retention ends.

### 3.6 Options 3 and 4 measured

**Option 3, background on the device.** Rejected as the mechanism, kept as a nudge:

- There is **no iOS project** (`wallet:` has `android/` only). The Android app ships
  `@capacitor/push-notifications` and no background-task plugin (`wallet:package.json:33-42`).
  A Capacitor app's JS does not run while the app is killed; FCM data messages would need native
  code to do anything.
- The web app and PWA have no background execution worth relying on.
- **The key is passphrase-encrypted at rest** (`wallet:src/lib/nap.ts:32-44`). A background task
  cannot derive the link key, sign NIP-98 or sign a witness without the passphrase. So even on a
  platform that did wake the app, it could not take the gift back.
- Worth keeping: a push or bell entry at `x` saying "Your Cashlink expired. Open Imani to finish
  taking it back." The web push and inbox already exist (`wallet:docs/native-push-activation.md`).

**Option 4, API/SDK reconcile.** Needed, but it is a trigger, not a mechanism. wallet-api is
stateless and keyless (ADR 0001/0002), so "reconcile" over the API is plan-then-sign: the caller
passes its link records in, the API answers which are claimed, which were refunded and are waiting
to be re-formed, and returns the unsigned steps; the caller signs. Today the API cannot even create
a Cashlink, so employer sending over the API is a prerequisite feature, not part of this issue (Q6).

**Option 5, shorter default plus reminders.** Cheap and harmless, does not close the gap. The
reminder is the option 3 nudge.

---

## 4. The limit, restore and History

### 4.1 `MAX_OUTSTANDING_LINKS`

Two changes, both wallet-only, both shippable now (phase 0):

- `sendGift` runs `reconcileGiftLinks()` before it counts, so a link that has expired and can be
  taken back is taken back first, and a link that was claimed is marked.
- Count a link only while it can still be claimed: `status === 'outstanding' && now < x`. A link
  past `x` stops counting even if it has not been taken back yet.

The second change on its own, before phase 1, lets a sender hold up to ten claimable links plus
any number of expired, not-yet-returned ones, each still claimable until the wallet runs. That is
the bearer exposure the limit was meant to bound (spec §6.7: "how much one wallet can park on
relays"). So before phase 1 also cap expired-but-unreturned links (say 10 more). After phase 1 a
link past `x` is armed for refund, so it can be dropped from the count outright.

### 4.2 Restore

`restoreScan` (`giftLinks.ts:503-541`) adopts a link only if its gift is still UNSPENT (`:532`).
It must also adopt a link whose gift was **spent by `R_i`** and not yet re-formed, read from the
NUT-07 witness, then rebuild `s_ij` and `r_ij` from the identity and run section 3.3. Everything
needed is derivable from the seed plus the gift wrap on the relay, so nostrdb retention of
kind-1059 wraps must cover `x` plus the re-form window (spec §6.6 already asks for `x` plus a
margin). `adoptLink`'s 30-day clamp (`:552-554`) stays; it only decides when an adopted
link counts as expired, and phase 1 links carry `x` in their own `locktime` tag, which is better
than the clamp.

### 4.3 History

`giftStatusLabel` (`wallet:src/lib/transactions.ts:316-321`) has `claimed`, `reclaimed` ("Taken
back"), `expired`, `outstanding`. Add one status, `returning`: the relay has pulled the gift off
the link and the voucher is not re-formed yet. Label it **"Taken back"** too (the coupon is
safe and only this wallet can finish it), with the voucher row showing "finishing…" until step 3.3
completes. `reclaimed` then means "re-formed in this wallet", exactly as today. The NIP-44 history
record (`gift_link`) carries the new status so a second device agrees.

---

## 5. Options compared

"Late claim" means a claim with the link after `x`. "Sender offline" means the sender never opens
the app again.

| | Returns with sender offline | Late claim refused by the mint | Holds anything spendable | Repos | Effort | Main risk |
|---|---|---|---|---|---|---|
| **0. Today** | No | No (bearer) | No | — | — | The gap in #295 |
| **1. NUT-11 lock only** (`locktime=x`, `refund=sender`) | No | **No.** NUT-11 keeps the link key valid after `x` | No | gc, wallet, mint tests | L | Looks like it fixes expiry and does not |
| **2. Server sweeper, bearer gift** | Yes | Only once it sweeps | **Yes: custody** | gc | M | Breaks ADR 0001. Rejected. |
| **1 + 2′. Lock + pre-signed refund relay** (recommended) | **Yes: off the link at `x + ε`, back as a voucher at the next run** | Yes, from `x + ε` (spent) | **No** | gc, wallet, mint tests, deploy | L | New gc re-sign route (oracle surface), D9 for the claim |
| **1 + 2′ + co-signer** | Yes | **Yes, from `x` exactly** | No (half of a 2-of-2) | as above + co-signer in gc | L+ | Claims need the co-signer up; it sees every claim |
| **1 + 2′ + mint extension** (main path off after `locktime`, Imani-only for `P2PK_VOUCHER`) | Yes | **Yes, from `x` exactly** | No | + mint, lib, wallet verifier | L+ | Departs from NUT-11 inside a kind that today "cannot drift" by delegation (`P2PKVoucherSpendingCondition.java:37-40`) |
| **3. Background on device** | Not reliably (no iOS app, no background JS, key locked at rest) | No | No | wallet, native | M | Silent non-delivery |
| **4. API reconcile** | Only for a caller that runs it | No | No | wallet-api | S–M | A trigger, not a guarantee |
| **5. Shorter default + reminder** | No | No | No | wallet | S | Narrows, does not close |

The co-signer variant: `n_sigs = 2`, `pubkeys = [cosigner]`, `refund = [R_i]`. Before `x` a claim
needs the link key **and** the co-signer, who signs a claim's `SIG_ALL` message only while
`now < x`. After `x` the main path needs a signature the co-signer will not give, so the mint
refuses every claim, and the refund (one key) is uncontested. The co-signer cannot spend alone. It
is a policy server rather than mint arithmetic, and a claim fails while it is down.

---

## 6. Recommendation

**Lock the gift to the link key with a refund path, and pre-sign the refund at creation so a
relay holding nothing spendable pulls the gift off the link at `x`.** The sender's wallet, app or
API, re-forms the voucher the next time it runs. Ship the counting and docs fixes first, because
they do not depend on any of it.

What this buys:

- The voucher leaves the link within minutes of `x` without the sender, and from then on the
  **mint** refuses the claim ("already spent").
- Self-custody holds. The relay is a timer with a stamp: a breach is a denial or a privacy leak,
  never a theft.
- Every intermediate state is recoverable from the seed: the refund outputs are derived, NUT-09
  restore returns them, and the re-sign route is idempotent for a resent proposal.
- No mint change for semantics. The mint already enforces locktime, refund and `SIG_ALL` on
  `P2PK_VOUCHER` by delegation.

What it costs, plainly:

- **"Returns to the sender" means the value, not the voucher, while the sender is away.** The
  coupon is safe and only the sender can finish it, but it is not spendable as a coupon until the
  sender's wallet runs once. The acceptance criterion needs to say this (Q1).
- **A window of `ε` after `x`** in which a late claim can still win, unless the co-signer or the
  mint extension is added (Q2). With a one-minute relay schedule, `ε` is about a minute plus mint
  latency; the recipient's wallet still refuses past `x` on its own side.
- **A new issuer re-sign route in gc** (bearer gift to link-locked), and a relaxed rule for
  re-signing a predecessor that has a refund path. Both are oracle surface. They must stay
  allowlists, keep the burn bound, the one-signature-per-burn claim and the #141 sat bound, and
  pin the exact shape: one `refund` key, no `n_sigs_refund`, `sigflag = SIG_ALL`, `x` at most
  30 days ahead and at least a margin (say 24 h) before the coupon's own expiry.
- **The claim becomes a wallet-side burn and re-sign**, which needs D9 narrowed (Q3).
- **The recipient may end up with a locked coupon** where today they get an unlocked one, with
  the locked-send limits that brings (Q4).
- **Whole-number-ratio coupons stay out.** cashu-voucher#59 makes them fail verification, so they
  can neither be locked nor re-signed until #59 lands, which D10 sequences after #540 enforce. They
  already fail at the mint today, so the picker should exclude them now.
- **Privacy:** the relay learns each gift's `Y`s, amount and `x`. Deposits signed by the link key
  keep the sender's identity out of it.

Safety requirements that must be tests, not conventions:

1. A link-locked gift always carries exactly one `refund` key. A past-locktime `P2PK_VOUCHER`
   without one is anyone-can-spend (`P2PKLocktimeUnlockTest.java:81`).
2. `SIG_ALL` on every link-locked secret, one swap per proof.
3. The refund relay and every re-lock send no `X-Cashu-Voucher-Redemption` or
   `X-Cashu-Voucher-Redeemer` (D9/D11 guards extended).
4. A refund-spent predecessor can be re-signed only by the refund key; a link-spent one only by the
   link key (section 3.4).
5. The recipient's successor carries no `locktime`, `refund` or `sigflag`.
6. `x + margin < expires_at` at lock time.

---

## 7. Open questions for the owner

| Q | Question | Recommendation |
|---|---|---|
| Q1 | Is "the value leaves the link at `x` and comes back as the voucher at the sender's next run (app or API)" acceptable as "returns to the sender without opening the app"? | Yes, and reword the criterion and `docs/customers.md` to say so |
| Q2 | Strict expiry: accept the `x + ε` window, or add the claim co-signer, or extend `P2PK_VOUCHER` in the mint? | Ship the window (target `ε` ≤ 2 min), decide strict separately; prefer the co-signer if strict is needed, because it stays inside NUT-11 |
| Q3 | Does D9 cover a **customer** claiming a link-locked gift by self-swap (it credits nobody)? And for a stall opening a gift of its own coupon: keep it on gc's declaring receive, or refuse it? | Narrow D9 to redemption (a stall receiving its own coupon); refuse self-swap claims by the coupon's own issuer |
| Q4 | After claiming, should the recipient hold a coupon locked to their key (like purchased coupons) or an unlocked one (like today's gifts)? | Locked, if `force-swap-on-no-swap-branch` stays off; otherwise unlocked, which needs a cross-shape re-sign and is more work |
| Q5 | Where does the refund relay run: gateway-customer, a new service, or public on a relay? | gateway-customer, with its own mint client that cannot carry the redeemer token |
| Q6 | Is API-driven Cashlink sending (employers) in scope now? Today wallet-api cannot create a Cashlink at all. | Separate issue. Here, only plan-then-sign reconcile for links the caller already has |
| Q7 | Do link-locked gifts wait for #540 enforce? | No hard dependency (nothing new declares), but land the gc re-sign route after enforce if possible, as D10 does for #59, because it widens the signing surface |
| Q8 | Gift expiry choices: keep 1 / 7 / 30 days, with the new rule that `x` must be at least 24 h before the coupon's own expiry? | Yes |

---

## 8. Phased plan

Each phase is its own PR or set of PRs, independently reviewed, owner-approved before merge or
deploy, as in the claim-links spec.

### Phase 0: honest limits now (wallet only, no protocol change)

- `sendGift` reconciles before counting; count `outstanding && now < x`; cap expired-unreturned
  links at 10.
- Gift picker excludes whole-number-ratio coupons (cashu-voucher#59).
- `giftExpiry`: `x` at least 24 h before the coupon's expiry.
- A bell or push entry at `x`: "Your Cashlink expired. Open Imani to take it back."
- `docs/customers.md` "Sending a Cashlink": say what happens today, exactly.
- wallet-api: `POST /links/status` (NUT-07 over caller-supplied link records, no keys).

Done when: a sender with ten expired links can make an eleventh after opening Send; tests for
the count, the reconcile-before-send, the clamp.

### Phase 1: prove the mint (cashu-mint tests only)

- `P2PK_VOUCHER` with `locktime` + one `refund` key + `SIG_ALL`: refund before `locktime` refused;
  refund after accepted; main key after `locktime` **accepted** (documents section 2.1); voucher
  input to plain outputs under `SIG_ALL`; a two-proof `SIG_ALL` swap refused (tag uniformity);
  expired voucher refused on the refund path.

Done when the suite pins all six; no production change.

### Phase 2: gc signing rules (imani-gateway-customer)

- New route: lock a burnt gift proof to `P2PK_VOUCHER(data = linkPub, locktime = x, refund = [R], sigflag = SIG_ALL)`,
  same guards as reissue, exact-shape allowlist.
- Reissue: a predecessor with a refund path may be re-signed by the pathway whose witness spent it
  (NUT-07); successor drops `locktime`, `refund`, `sigflag`.
- Tests: every refusal arm, the #136-style front-run after a refund, the sat bound.

### Phase 3: the refund relay (gc, deploy)

- Deposit endpoint (NIP-98 by link key, idempotent per proof), scheduler at `x + 60 s`, response
  retention, fetch endpoint; a mint client that cannot send redemption headers.
- Metrics: deposits, refunds posted, already-spent, failures; alert on refunds overdue by > 5 min.

### Phase 4: the wallet (imani-wallet)

- Send by link: after the atomic send, burn, lock, publish the locked gift to the link key,
  pre-sign and deposit the refund swaps. A deposit failure is shown and retried; the link still
  works, it is just not armed.
- Claim: burn + re-sign + mint (needs Q3).
- Reconcile: distinguish claimed from refunded by the witness; re-form refunded links; status
  `returning` then `reclaimed`.
- `restoreScan`: adopt refunded-but-not-re-formed links; derive outputs; NUT-09 restore.
- wallet-api: plan-then-sign re-form for API callers.
- Docs: `customers.md`, spec §3.3/§6 amended.

Done when the #295 acceptance tests pass on the local gate: expiry with the app closed (the
relay refunds, the wallet re-forms on next open); a claim after `x + ε` refused by the mint; restore
after expiry re-forms; the limit is freed; History says Taken back; an API caller re-forms without
the UI.

### Phase 5 (if Q2 says strict): co-signer or mint extension.

---

## 9. What this does not solve

- **A sender who never runs the wallet again** has their coupon's value safe, off the link and
  unspendable by anyone else, but never re-formed. It is recoverable by restore at any later time,
  as long as the coupon has not expired and the gift wrap is still on the relay.
- **The `ε` window** (Q2).
- **Gateway privacy.** gc already sees every voucher successor secret at re-sign time
  (`the-wallet-swaps-its-own-receives.md`, "The privacy leak"); the relay adds the refund side.
- **Fees and keysets.** The pre-signed amounts assume `input_fee_ppk = 0` for voucher swaps and
  that the keyset is still active at `x`. If either changes, the refund is refused safely (nothing
  is signed) and the wallet's own reconcile takes the gift back as today.
