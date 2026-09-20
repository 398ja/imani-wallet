# Can the audit ledger catch a double spend or silent inflation?

A review of `src/lib/audit.ts`, `src/lib/attestation.ts` and
`services/audit-api/`, against the two questions that matter for money:

> Can this detect a **double spend**? Can it detect **silent inflation**?

Short answer: **double spend, yes, within one layer. Silent inflation, no — and
one of the paths that should prevent it is missing a check.**

Every claim below was executed against the repo's own code rather than reasoned
about. The evidence is not all of the same grade, and the difference matters:

| Finding | How it was established | Grade |
|---|---|---|
| 1 — cross-stall redemption | `createDmCryptoAdapter()`, the adapter dm-poll installs, driven with signed fixtures. Committed as a test. | **Acceptance path** |
| 2 — self-referential signature | `verifyVoucher` called directly. One layer below the gate. | Unit-level |
| 3 — no range proof | `commitTo`/`verifyDisclosedTotal` called directly with a mod-n negative. | Unit-level |
| 4 — no issuer in the payload | Structural: read of the wire format and the reader. | Inspection |

Findings 2 and 3 describe a **modified publisher or issuer**, which by
definition cannot be exercised through the shipped wallet's own path — the
wallet will not construct these inputs. That is a real constraint, recorded
rather than papered over: they are reproducible against the exported primitives,
and the fraud path they describe requires an attacker who has replaced the
client.

Finding 1 needed no such caveat and so was held to the higher standard.

- [Verdict](#verdict)
- [What the ledger is, precisely](#what-the-ledger-is-precisely)
- [Double spend](#double-spend)
- [Silent inflation](#silent-inflation)
- [Finding 1 — the till does not check the coupon is its own](#finding-1--the-till-does-not-check-the-coupon-is-its-own)
- [Finding 2 — the issuer signature is self-referential](#finding-2--the-issuer-signature-is-self-referential)
- [Finding 3 — commitments have no range proof](#finding-3--commitments-have-no-range-proof)
- [Finding 4 — the attestation does not name the issuer](#finding-4--the-attestation-does-not-name-the-issuer)
- [What the implementation gets right](#what-the-implementation-gets-right)
- [Recommendations](#recommendations)
- [A correction made during this review](#a-correction-made-during-this-review)

## Verdict

| Question | Detected? | By what |
|---|---|---|
| Same token redeemed twice | **Yes** | Duplicate nullifier, cross-ledger |
| Two stalls claiming one token | **Yes** | `findDuplicates`, `benign: false` |
| A forged attestation | **Yes** | BIP-340 on every event |
| A merchant crediting less than face value | **Partly** | Only against their own disclosure |
| A merchant omitting a redemption | **No** | Stated limit; needs the mint |
| **A merchant redeeming a coupon they never issued** | **No** | No check anywhere on the DM path |
| **A merchant inflating a disclosed total downwards** | **No** | No range proof |
| **A self-issued voucher** | **No** (offline) | Mint catches it at swap; wallet does not |

Confidence that the ledger catches **double spend within the voucher layer**:
**high**. The nullifier construction is sound, the cross-ledger grouping is
right, and the benign/conflicting split is correct.

Confidence that it catches **silent inflation**: **low**, and it is important
to say this is mostly *by design* — the design document is explicit that
omission is out of scope and that the mint is the completeness oracle. What is
*not* by design is Finding 1.

## What the ledger is, precisely

One kind-7377 event per redemption:

```
nullifier = SHA256("imani-redeem-v1:" || token)
C         = faceValue*G + r*H,   r = SHA256("imani-blind-v1:" || ledgerSk || nullifier)
signed by ledgerSk = SHA256("imani-ledger-key-v1:" || merchantSk)
```

It answers exactly one question honestly: *was this specific token honoured, and
by whom (pseudonymously)*. Everything else is inference.

Critically, **an attestation says "I credited N against some coupon"**. It does
not say which voucher, which issuer, or that the attester was entitled to honour
it. That gap is where inflation lives.

## Double spend

This works, and the reasoning behind it is good.

The nullifier is keyed on the **token**, not the voucher — correct, and the
non-obvious choice. A £10 voucher legitimately returns as £4 then £6, and a
voucher-keyed tag would report a false double-spend on every honest partial
redemption. It is also bound to the token's **secret bytes**, so an observer who
saw a coupon cannot pre-publish its nullifier to frame an honest redemption as a
replay. Both are load-bearing and both are documented with the reason.

`findDuplicates` groups **across ledger keys**, which catches the case a
per-merchant view cannot see: two different stalls both claiming the same token.
And the benign/conflicting split is right — derived blinds make republication
byte-identical, so the reconciliation sweep does not look like fraud every time
it runs.

**Caveat.** This detects a double spend in the *voucher* layer only, and only
for redemptions that were actually published. The sats layer is the mint's job.
The two are genuinely complementary, as the design says.

## Silent inflation

Inflation means value credited or claimed that was never issued. There are four
distinct ways to do it here, and the ledger sees none of them.

### 1. Redeem a coupon you never issued — **unprotected, see Finding 1**
### 2. Self-issue a voucher — **offline unprotected, see Finding 2**
### 3. Understate a disclosed total — **unprotected, see Finding 3**
### 4. Omit a redemption entirely — **known and documented limit**

Only #4 is acknowledged in the design. The other three are not written down
anywhere, and #1 is a missing check rather than a design trade.

## Finding 1 — the till does not check the coupon is its own

**Severity: high. This is the one to fix.**

There are two redemption paths and they disagree:

| Path | Checks `issuerId == my stall`? |
|---|---|
| `services/wallet-api/redeem.ts` → `verifyCoupon` | **Yes** — `REFUSAL.ANOTHER_STALL` |
| `src/lib/dmPoll.ts` → `dmCrypto` — *the actual till* | **No** |

`verifyCoupon` has the check and states the reason well:

> a coupon is a claim on ONE stall, honoured by that stall alone. Accepting
> another stall's coupon is money that simply stops.

The DM path — which is every coupon arriving at a real merchant — does not.
`verifiedVoucherFrom` returns `REJECTED` only when `signatureValid` is false.
`refuseIfOverRedeemed` keys the ceiling on `voucherId` alone, so it bounds the
voucher against itself but never asks whose voucher it is.

**Confirmed at the real acceptance boundary**, not at the primitive underneath
it. `src/lib/__tests__/crossStallRedemption.test.ts` drives
`createDmCryptoAdapter()` — the exact adapter dm-poll installs at
`dmPoll.ts:735` — with genuinely signed tokens from the repo's own
`voucherFixtures`:

```
✓ is a genuinely signed voucher — the fixture is not the thing under test
✓ FINDING: is accepted, though the coupon is a claim on a different stall
✓ FINDING: reports the other stall as the issuer, and no refusal with it
✓ refuses a voucher whose signature does not verify
✓ lets plain ecash through, since it carries no issuer claim to check
```

The contrast lands in a single run: the **forged** voucher is refused (the
adapter logs `rejecting voucher with invalid issuer signature`), while the
**other stall's** genuinely-signed voucher passes `extractToken` untouched.
dmCrypto's own comment calls `extractToken` *"the refusal gate, because
parseTokenTransferMessage alone is not one"* — and it returns the token.

The first test is a guard on the test itself: if the fixture stopped producing a
verifiable voucher, the others would pass for the wrong reason (refused as a
forgery rather than accepted as another stall's) and the finding would look
fixed.

The coupon is accepted, credited, and **attested**. `attestRedemption`'s only
gate is `signatureValid` (`attestation.ts:336`); `dmPoll`'s only gate is
`loadMerchant(currentPubkey) !== null` (`dmPoll.ts:648`). Neither compares
`issuerId` to the wallet's own stall key — and the metadata carries `issuerId`
off the *signed* voucher, so every input the check needs is already in hand.

**Consequences, in order of seriousness:**

1. A merchant's till credits a customer for a coupon the merchant cannot
   redeem — the merchant absorbs the loss, exactly the harm `verifyCoupon`'s
   comment describes.
2. The merchant then publishes a public attestation claiming they honoured it,
   inflating their own apparent takings with value they never issued.
3. `redemptionLedger`'s ceiling is per-voucher and local, so the *issuing* stall
   never sees that someone else has been redeeming against their voucher.

Note this is also a **liveness** bug before it is a fraud one: the honest case
(a customer walking to the wrong stall) is more likely than the malicious one,
and it silently costs the merchant money.

**The precedent for the fix already exists in this codebase.**
`credentialActor` (`terminalCredential.ts:181`) does exactly this comparison for
terminal credentials, with the same justification: *"A voucher minted by some
other stall, or by the terminal itself, is refused even though its signature is
perfectly valid."*

## Finding 2 — the issuer signature is self-referential

**Severity: medium offline, low in production.**

`verifyVoucher` checks the signature against `issuerPublicKey` **carried inside
the voucher being verified**. Whoever signs the voucher also names the key it is
checked against.

```
A) issuerId = a real stall, signed by an attacker's own key
   signatureValid = true     issuerPub = 1f9b7558…   ← not the stall
B) wholly self-issued voucher, faceValue 1,000,000
   signatureValid = true
```

So `signatureValid: true` means *"this voucher is internally consistent"*, not
*"a party I trust issued this"*. The name invites the stronger reading, and
`attestRedemption` relies on exactly that reading when it uses `signatureValid`
as its sole gate for signing a public claim about value.

**What saves this in production** is the mint: it only signs proofs for keysets
it holds, and ADR 0006 puts a `(mint, issuer)` allowlist on the gateway path. A
self-issued voucher has no valid mint signature, so the swap fails.

**What it breaks is the offline promise.** `voucherToken.ts` opens with:

> Deliberately no network: a merchant at a stall with no signal must still be
> able to tell their own coupon from someone else's, which is what makes the
> offline cap meaningful rather than a guess.

Offline, it cannot. The only check available without a network is the
self-referential one. Finding 1's fix substantially closes this too, because a
self-issued voucher naming a fake stall would then be refused for naming the
wrong stall.

**The full fix needs a pinned key and that is a deployment decision.** The shape
already exists for licences: `VITE_LICENCE_ISSUER_PUBKEY`, where empty means
nothing verifies, and `verifyLicence` refuses `WRONG_ISSUER` *before* checking
the signature. There is no coupon equivalent. See the correction at the end of
this document about which key that would have to be.

## Finding 3 — commitments have no range proof

**Severity: medium. Affects the disclosure check only.**

Pedersen commitments are additively homomorphic over a cyclic group, so a
commitment to `n - 6000` behaves as `-6000`. `commitTo` refuses a negative input,
but the reader only validates the **shape** of a published point
(`/^0[23][0-9a-f]{64}$/`), and a merchant running their own signer publishes
whatever point they like.

Probe:

```
honest 3 x 5000, claim 15000              -> true
same set,        claim  9000              -> false    correct
+ one commitment to (n - 6000), claim 9000 -> true     WRONG
```

A merchant can publish a well-formed attestation that subtracts from their
disclosed total. `/api/v1/audit/verify-total` returns `verified: true` for an
understated figure.

The endpoint's `note` carefully explains the **completeness** limit (the merchant
chooses which nullifiers to disclose). It says nothing about **soundness** — that
a disclosed set can contain a negative element. The documentation is precise
about the limit it knows and silent about this one, which is the more dangerous
shape: a reader who took the note seriously would believe the remaining
guarantee is stronger than it is.

Note this requires a *modified publisher*; the shipped wallet cannot do it. It is
a fraud path, not a bug in normal operation.

## Finding 4 — the attestation does not name the issuer

**Severity: structural. This is why Finding 1 is invisible to the ledger.**

The wire format carries `nullifier`, `commitment`, `unit`, `v` — and nothing
about which voucher or which issuer. Combined with the deliberate absence of any
`ledgerPubkey -> stall` mapping (decided against in 2026-09, for good reasons
about breach blast radius), an auditor sees:

- a commitment from ledger `a617…`
- no way to learn which stall that is
- no way to learn which stall issued the coupon

So "stall X is redeeming coupons issued by stall Y" is **not expressible** in the
current stream, whatever the reader does. Detecting Finding 1 from the ledger
alone would need the issuer in the payload — and that has a real privacy cost,
because `issuerId` is a stall's actual pubkey and putting it in cleartext
partially undoes the pseudonymity the whole design is built on.

A commitment to `issuerId` (openable on disclosure) would preserve pseudonymity
while making the check possible. That is a wire-format change and deserves its
own design pass.

## What the implementation gets right

Worth recording, because the quality here is genuinely high and the findings
above are narrow by comparison.

- **The one-way dependency.** Reader never imports the producer, so the hosted
  API cannot load a signer. A compromise of the audit service forges nothing.
- **`stripCachedVerdict`.** A real, measured hole — nostr-tools memoises its
  verdict in a symbol, symbols survive spread, so `{...genuine, sig: 'ff…'}`
  verified `true`. Found by a test that expected a forgery to be refused.
- **Rejections are named, never silent.** An audit tool that quietly drops what
  it cannot read reports a clean ledger for a broken one.
- **Absence is gated.** `ABSENCE_SLA_MS`, no-timestamp-no-accusation, truncation
  downgrading `missing` to `pending`, `redeemedAt` bounds against backdating.
  The system consistently refuses to manufacture accusations, and each guard
  names the attack it stops.
- **The cleartext relay analysis.** Recognising that an attacker who cannot
  forge can still *withhold*, and that withholding manufactures a public
  accusation, is a genuinely subtle threat-model result.
- **The independent Python verifier.** BIP-340 from the spec, sharing no code,
  because a probe that imports the reader can only confirm the reader agrees
  with itself.
- **Comments that record what was wrong before.** Several say "an earlier
  version of this comment claimed X; review caught it". That is unusually honest
  and it is why this review could move fast.

The documentation's habit of stating limits plainly is the reason Findings 1-3
are findings rather than disagreements: the docs are right about everything they
cover, and these are the cases they do not cover.

## Recommendations

Ordered by ratio of risk closed to effort and blast radius.

### 1. Refuse another stall's coupon on the DM path — **do this first**

Add the `issuerId != own stall` refusal to `dmCrypto.verifiedVoucherFrom`,
mirroring `verifyCoupon` and `credentialActor`. Small, testable, no wire change,
no privacy cost. Closes the honest-loss case as well as the fraud one.

Two details that need care:
- Plain ecash (no voucher) must keep flowing, as it does today.
- A **customer** receiving a coupon is not redeeming it, and must not be
  refused. The check belongs where the merchant honours a claim on themselves,
  so it should be gated the same way `attestRedemption` is.

### 2. Say out loud what `signatureValid` means

Rename or document it as *internally consistent*, not *trusted issuer*. Cheap,
and it stops the next caller making the same inference `attestRedemption` makes.

### 3. State the soundness limit on `verify-total`

Add to the `note`: a `true` binds the disclosed set *given every commitment is
to a non-negative amount*, which the stream does not enforce. Documentation-only,
and it stops the endpoint overstating.

### 4. Pin a coupon issuer key (deployment decision)

Mirror the licence pattern. Needs a decision about *which* key and what happens
to existing vouchers, so it is a design conversation rather than a patch.

### 5. Commit to `issuerId` in the attestation (design pass)

Makes Finding 1 detectable from the ledger without publishing stall identities.
Wire-format change, `v: "2"`, and the reader is already built to refuse unknown
versions — so the migration path exists.

### 6. Range proofs (probably not worth it)

Bulletproofs would close Finding 3 properly and cost a large dependency plus
per-event proving time. The cheaper mitigation is to have `verify-total` require
per-nullifier openings before reporting `verified`, which is sound and needs no
new crypto. Recommend the cheap version.

## A correction made during this review

An earlier draft of this analysis recommended **binding `issuerPublicKey` to
`issuerId`** to fix Finding 2. That is wrong, and the codebase already knows it.

`terminalCredential.ts:149`, established against the live gateway:

> The issuer here is the voucher's `issuerId`, NOT its `issuerPublicKey`.
> Minting one against the live gateway is what showed the difference:
> `issuerPublicKey` is the GATEWAY's signing key, the same for every voucher it
> mints, so comparing the stall against it refuses every real credential ever
> issued.

So that binding would refuse every genuine coupon. The correct pin is the
**gateway's** key, which is Recommendation 4 and a deployment decision, not a
code change.

Recorded rather than quietly removed, in the same spirit as the "review caught
it" comments throughout this subsystem — and because the mistake is an easy one
to make twice.
