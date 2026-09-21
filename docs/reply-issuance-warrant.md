# Reply: warrant scheme accepted, with one correction and one gap

**To:** the issuance path team (`imani-gateway-core`, `cashu-voucher`)
**From:** `imani-wallet`
**Re:** `imani-gateway-core/docs/issuance-authorisation-warrant.md`
**Status:** proposal accepted. Two items to fold in before step 2 lands.

---

## 1. Accepted, including the part that overrides us

The reframe is right and it is better than what we asked for.

We asked "who authorised this", which is the question that makes a
countersignature the obvious answer. You pointed out the damage is not that a
coupon names the wrong stall, it is that **an unbacked claim exists against a
stall that was never paid**, and a countersignature authenticates the debtor
while leaving the amount entirely to the signing key. That is correct and we
missed it. Our §5 conceded the countersigning key would be a lock key on an
always-on service, and then did not follow that concession to its conclusion:
it relocates the prize without bounding the loss.

The self-defeating property is the strongest argument in either document.
Forging a 50,000 EUR `processor` warrant requires routing 50,000 EUR of real
money into the victim's own Stripe account. We had nothing like it.

**§4.2 is the finding of the exchange**, and it is yours, not ours. `/cash` is
already under `nip98-protected`, the merchant already signs kind 27235 at the
counter, `Nip98AuthFilter` already verifies the Schnorr signature and the
payload hash, and then `new NostrAuthentication(...)` drops the `sig`. We
argued for months that ADR 0009 put the stall's key out of reach at issuance.
On the cash path it was in the loop the whole time and we were discarding the
proof. That reframes the cash arm from "new ceremony" to "stop throwing
evidence away", which is a different cost class entirely.

Your `NapProxyAuthFilter` qualification is the kind of thing we would have
shipped a bug on. Both filters populate `NostrAuthentication` identically, so
deriving a `merchant` warrant from `SecurityContext` alone would mint a warrant
asserting a signature that never existed. Recording the **mechanism** and not
just the pubkey is right, and step 1 is correctly ordered ahead of everything.

---

## 2. One correction: the key count, and why your decoder disagreed

Your §10 caveat says the script finds three vouchers under two keys against our
four, and attributes the gap to fixtures "whose metadata this decoder does not
reach". The count is ours and it holds; the attribution is not quite right, and
the reason matters more than the number.

Re-derived just now, all eight fixtures, through the wallet's own parser:

```
control-unlocked           b1787b2b98a5  6a02bb648b32   unlocked
live-licence               7952939535a7  4b22d0ec272d   unlocked
live-terminal-till         b1787b2b98a5  4b22d0ec272d   unlocked
live-terminal-credential   b1787b2b98a5  0d042df74d58   P2PK
magento-demo-credential    7952939535a7  27aa1ecd8aa7   P2PK
revocation-probe           b1787b2b98a5  27aa1ecd8aa7   P2PK
witness-positive           b1787b2b98a5  6a02bb648b32   P2PK
witness-test               b1787b2b98a5  6a02bb648b32   P2PK

TOTAL KEYS 4      stall b1787b2b98a5 -> 4 keys
```

The three your script decoded are **exactly the three unlocked ones**. The
skip is not partial metadata reach, it is categorical: on a `P2PK_VOUCHER` the
secret's `data` field holds the **lock key hex**, not the CBOR blob, so
`decode(Buffer.from(body.data,'hex'))` throws and `catch { continue }` drops
the voucher silently. Five of eight, every locked one.

**Why this is worth fixing rather than noting.** The vouchers your decoder
cannot see are the terminal credentials. Those are the ones that carry
`issue`/`redeem` authority, and they are the population our Finding 6 fourth
test forges. A verification script for a scheme about issuance authority is
currently blind to precisely the tokens that grant issuance authority. The two
keys it misses, `0d042df7` and `27aa1ecd`, appear **only** on locked tokens.

Your conclusion is untouched: `4b22d0ec` signing for two stalls is visible in
the three it does read, and that row is the decisive one. But the script should
read the lock key from `data` and the voucher blob from the tag rows on the
P2PK kind, the way `parseVoucherToken` does, or at minimum count and announce
its skips rather than `continue`. It currently prints a clean pass over a 62%
sample. That is the same failure shape your §10 already caught once with the
silently-skipping codec probe.

---

## 3. One gap: §7.4 is right about split validity and stops one step early

§7.4 says consolidation needs an explicit rule and that "the split path is fine
(it reuses `signedVoucherBytes` verbatim and derives value through
`issuance_ratio`)".

**The validity claim is correct.** A split child keeps the parent's signed
bytes, so the parent's warrant still verifies. We are not disputing it.

The consequence is not stated, and it is a reading trap. The digest commits to
the parent's `faceValue`. After a split the child is worth less. So on a split
child a warrant is simultaneously **valid** and **not a statement about what
that coupon is now worth** — over-stating it by the spent amount, in the
direction that favours the holder.

`imani-wallet/src/lib/__tests__/warrantSplitBinding.test.ts`, 4 cases:

| Case | Shows |
|---|---|
| parent digest vs child digest | bound to the issued amount, not the held one |
| valid-but-overstated | signature authenticates 2500 while 2100 is held |
| chained splits | gap widens to 4x, signature never stops verifying |
| the obvious fix fails | rebinding to held value needs the stall at split time |

The fourth case is why this is a verifier rule and not a digest change: nobody
can sign the child's digest, because only the stall could and it is not present
at split time. That is ADR 0009 again, so the warrant **must** stay bound to
issuance.

This is the `longValue()` shape once more, and also the `imani-apps`
"25 XAF credited as 5000" shape: a value that is right in one representation
and read as authoritative in another. Our `pay.ts` already carries a comment
about re-inflation on exactly this path.

Suggested wording for §7, as item 6:

> A warrant attests the **issued** face value. On a split child it remains
> valid while describing an amount larger than the child is worth. Verifiers
> must treat a valid warrant as a ceiling on the issuance, never as a statement
> about the coupon in hand. UI must not render "authorised" against a split
> child's current balance.

The ceiling framing matches what we already do with `faceValue` against an
unsigned `issuance_ratio`, so it is a rule the wallet is shaped for.

---

## 4. On `none`, agreed, with one addition

Making absence an explicit signed statement is right, and "an absent field and
a field saying `none` are different claims" is the correct instinct.

One thing to nail down in step 2: on a voucher issued **before** warrants
exist, the field is absent and the issuer signed nothing about it. That is a
third state, not the same as signed-`none`. Our reader will distinguish
absent-legacy from signed-`none` from present-and-valid, and we suggest the
codec does too, so the epoch flip in step 7 can refuse signed-`none` while
still loading pre-epoch tokens. Collapsing them is how the downgrade you are
guarding against walks back in through the legacy door.

---

## 5. What we will do, and when

| | Wallet action | Trigger |
|---|---|---|
| now | Record §9.3's sentence verbatim in our review doc | done with this reply |
| now | `warrantSplitBinding.test.ts` as the executable form of §3 | landed |
| step 2 | Reader parses `issuance_warrant`, refuses unknown forms, distinguishes the three absence states | when you publish the format |
| step 5 | Surface warrant state in redemption UI, advisory | after reader ships |
| step 7 | Refuse per rail | your call, per rail |

Per §9.3 we have written into
`docs/research/audit-double-spend-inflation-review.md` that a coupon's
`issuerId` is an assertion by the issuing service and not a claim proven by the
named stall, and that this is accurate until §8 completes.

Two things we need from you before our step-2 work is real: the wire shape of
`issuance_warrant` as it will sit in `SignedVoucherCodec`, and confirmation
that the digest preimage is field-separated. Our test assumes `\u001f` between
fields, matching your script. If the production digest concatenates without a
separator, `faceValue=25,decimals=00` and `faceValue=2500,decimals=0` collide,
and that is a real forgery rather than a theoretical one.

---

## 6. Reproducing §3

```bash
cd imani-wallet
npx vitest run src/lib/__tests__/warrantSplitBinding.test.ts
```

Our Finding 6 evidence, unchanged:

```bash
npx vitest run src/lib/__tests__/issuerAttestationLimit.test.ts
```
