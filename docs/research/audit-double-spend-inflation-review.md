# Can the audit ledger catch a double spend or silent inflation?

A review of `src/lib/audit.ts`, `src/lib/attestation.ts` and
`services/audit-api/server.ts`, against the two questions that matter for money:

> Can this detect a **double spend**? Can it detect **silent inflation**?

Short answer: **double spend, yes, within one layer. Silent inflation, no — and
one of the paths that should prevent it was missing a check.**

## Status

| Finding | State |
|---|---|
| 1 — cross-stall redemption | **Fixed.** `refuseIfAnotherStalls`, refusing before the mint swap. |
| 2 — self-referential signature | **Fixed offline.** `issuerAllowlist.ts`, opt-in per deployment. |
| 3 — no range proof | **Fixed.** `/verify-openings` is sound; `/verify-total` stays and says what it is not. |
| 4 — no issuer in the payload | **Fixed.** Attestation v2 carries a hiding commitment to the issuing stall. |
| 5 — cashback unattested | By design. Now stated in the API's own payloads. |
| **6 — issuance rests on the signing service** | **OPEN, and structural.** Not closable in the wallet. See below. |
| Gap — refusals were silent | **Fixed.** `redemption:refused` is typed, carries a reason, and is shown. |

All six recommendations are implemented. **Three of them changed shape under
measurement**, and those reversals are the most useful thing in this document:

- **Rec 4** was "pin one key". Real tokens carry four distinct issuer keys,
  and the field is not a constant. A single pin would have refused genuine
  coupons. It is an allowlist.
- **Rec 5**'s obvious form — write `issuerId` into the event — would have
  de-anonymised every stall. Measured: a plain hash is brute-forceable over the
  public stall list. It is salted with the ledger secret.
- **Rec 6**'s cheap form — range-check the disclosed amounts, then one
  aggregate check — is **not sound**, and that was measured rather than
  reasoned about. Only per-commitment openings tie a commitment to an amount.

**One finding remains open and it is the largest.** Finding 6: a voucher
carries exactly one signature and it is the signing *service's*, not the
stall's — so "stall X issued this" is an attestation nobody can verify against
X. A compromised service can mint any amount in any stall's name and the result
is indistinguishable from a genuine coupon. It needs a stall countersignature,
which is a protocol change outside this repo.

**Answered, and the answer was better than the question.** The gateway team
confirmed the finding independently and then declined the countersignature for
a reason we had missed: it authenticates the *debtor* and leaves the *amount*
to whoever holds the key. Their counter-proposal, an `issuance_warrant`
(`imani-gateway-core/docs/issuance-authorisation-warrant.md`), binds a digest
that **covers the face value** to evidence from outside our trust boundary —
the merchant's own NIP-98 signature on the cash path, a Stripe charge on the
stall's own connected account on the card path. Forging a large coupon then
requires routing that much real money into the victim's account, so it is
self-defeating rather than merely detectable. Our reply, including one
correction and one gap we found in it, is `imani-docs/wallet/reply-issuance-warrant.md`.

**The recordable decision, per their §9.3, verbatim:** a coupon's `issuerId`
is an **assertion by the issuing service**, not a claim proven by the named
stall. That is accurate today and stays accurate until their §8 sequencing
completes.

**IMPLEMENTED.** The warrant now ships end to end across six repos —
`cashu-lib`, `cashu-voucher`, `imani-gateway-api`, `-core`, `-customer`,
`-portal` and this wallet. An owner's device signs a digest covering the sale
amount before the Sell request leaves it; the gateway refuses a warrant that
does not cover the sale; the signature is inside the voucher's signed bytes so
a compromised service cannot strip it; and a redeeming merchant sees the state
on the coupon. See `imani-docs/wallet/plan-issuance-warrant.md` for what shipped and the
three things that plan got wrong.

**Finding 6 is narrowed, not closed, and the distinction matters.** A
compromised service still mints coupons naming any stall. What it can no longer
do is produce a *warrant* for them, because that needs a key it does not hold.
So the forgery becomes detectable rather than impossible, and only on coupons
issued by an owner device: terminals emit a signed `none` because their key is
not the stall's, and every coupon predating this carries no warrant at all.
Until a policy flip refuses unwarranted coupons — which nobody has taken, and
which would paint most of the estate red today — a forger's best move is simply
to omit the warrant.

## Scope, and what was not looked at

Read closely: the reader, the producer, the hosted API's routing, the design
document, the technical guide, the DM receive path (`dmCrypto.ts`, `dmPoll.ts`),
the wallet-api redeem path, and the redemption ceiling.

**Not reviewed**, and a reader should know it: `services/audit-api/metrics.ts`,
`src/pages/LedgerPage.tsx` (the merchant's own view), `validationStatus.ts`,
`scripts/verify-attestations.py` (the independent verifier), and the
Prometheus alert rules. None of these is on the money path, but the merchant
view in particular is where a self-auditing stall would first notice or miss a
problem, and it deserves its own pass.

Nothing was run against a live relay or mint. Every claim about the mint's
behaviour is from reading ADR 0005/0006, not from observing it.

**What the cross-stall fix was and was not exercised against.** The refusal is
driven through the adapter `startDmPoll` installs, which is the integration
boundary inside the wallet, with a stub standing in for the mint. Not exercised:
a real gift wrap arriving over a relay, a real mint swap, or an end-to-end run
on a merchant device.

**And one gap that is not a testing limitation but a missing feature.**
`DmPollService` emits `redemption:refused` when either refusal fires, and
**nothing in this wallet subscribes to it** — verified by search. So a merchant
whose till refuses a coupon sees the coupon simply not arrive, with no
explanation on screen. This predates the cross-stall check: the ceiling refusal
has always been silent the same way. It matters more now, because the new
refusal has an honest and likely cause a merchant can act on — *"that coupon is
for another stall"* — and telling them costs one listener. Worth its own ticket;
deliberately not bundled into this change.

Every claim below was executed against the repo's own code rather than reasoned
about. The evidence is not all of the same grade, and the difference matters:

| Finding | How it was established | Grade |
|---|---|---|
| 1 — cross-stall redemption | `createDmCryptoAdapter()`, the adapter dm-poll installs, driven with signed fixtures. Committed as a test. | **Acceptance path** |
| 2 — self-referential signature | `verifyVoucher` called directly. One layer below the gate. Committed as a test. | Unit-level |
| 3 — no range proof | `commitTo`/`verifyDisclosedTotal` called directly with a mod-n negative. Committed as a test. | Unit-level |
| 4 — no issuer in the payload | Structural: read of the wire format and the reader. | Inspection |
| 5 — cashback unattested | Read of `cashback.ts` and the design document's own list of innocent gaps. | Inspection |
| 6 — issuance rests on the service | Eight real captured tokens, plus a forged coupon that verifies clean. Committed as a test. | **Real data + unit-level** |

Findings 2 and 3 describe a **modified publisher or issuer**, which by
definition cannot be exercised through the shipped wallet's own path — the
wallet will not construct these inputs. That is a real constraint, recorded
rather than papered over: they are reproducible against the exported primitives
(`src/lib/__tests__/auditSoundnessLimits.test.ts` pins both, so a change that
closed either would turn a test red on purpose), and the fraud path they
describe requires an attacker who has replaced the client.

Finding 1 needed no such caveat and so was held to the higher standard.

- [Scope, and what was not looked at](#scope-and-what-was-not-looked-at)
- [Verdict](#verdict)
- [Threat model: who can do what](#threat-model-who-can-do-what)
- [What the ledger is, precisely](#what-the-ledger-is-precisely)
- [Double spend](#double-spend)
- [Silent inflation](#silent-inflation)
- [Finding 1 — the till did not check the coupon is its own](#finding-1--the-till-did-not-check-the-coupon-is-its-own)
- [Finding 2 — the issuer signature is self-referential](#finding-2--the-issuer-signature-is-self-referential)
- [Finding 3 — commitments have no range proof](#finding-3--commitments-have-no-range-proof)
- [Finding 4 — the attestation does not name the issuer](#finding-4--the-attestation-does-not-name-the-issuer)
- [Finding 5 — the cashback path is a documented omission channel](#finding-5--the-cashback-path-is-a-documented-omission-channel)
- [Finding 6 — the issuance claim rests entirely on the signing service](#finding-6--the-issuance-claim-rests-entirely-on-the-signing-service)
- [What the implementation gets right](#what-the-implementation-gets-right)
- [Recommendations](#recommendations)
- [Errata: what this review got wrong, and when](#errata-what-this-review-got-wrong-and-when)

## Verdict

| Question | Detected? | By what |
|---|---|---|
| Same token redeemed twice | **Yes** | Duplicate nullifier, cross-ledger |
| Two stalls claiming one token | **Yes** | `findDuplicates`, `benign: false` |
| A forged attestation | **Yes** | BIP-340 on every event |
| A merchant crediting less than face value | **Partly** | Only against their own disclosure |
| A merchant omitting a redemption | **No** | Stated limit; needs the mint |
| **A merchant redeeming a coupon they never issued** | **Refused** | `refuseIfAnotherStalls`, before the swap |
| **… and visible in the ledger afterwards** | **Yes** | v2 issuer commitment, on disclosure |
| **A merchant inflating a disclosed total downwards** | **Refused** | `/verify-openings` |
| **A self-issued voucher** | **Refused** | `issuerAllowlist`, where configured |
| **A voucher minted by a COMPROMISED issuing service** | **No** | Finding 6 — needs a stall countersignature |

Confidence that the ledger catches **double spend within the voucher layer**:
**high**. The nullifier construction is sound, the cross-ledger grouping is
right, and the benign/conflicting split is correct.

Confidence that it catches **silent inflation**: **low**, and it is important
to say this is mostly *by design* — the design document is explicit that
omission is out of scope and that the mint is the completeness oracle. What is
*not* by design is Finding 1.

## Threat model: who can do what

Severity labels on their own do not say who the attacker is or what they need.
This table does, and it is what the recommendations are ordered by.

| Finding | Attacker | Needs | Gains | Caught by |
|---|---|---|---|---|
| 1 | Any merchant, **or an honest one by accident** | Nothing — the shipped app | Credits and attests a coupon they cannot redeem; the honest case *loses* money | Nothing on the DM path |
| 2 | Someone who can mint their own vouchers | A voucher signer, and the merchant offline | Offline, a self-issued voucher reads as genuine | The mint, at swap time, if online |
| 3 | A merchant | A modified publisher | `verify-total` reconciles at an understated total | Nothing |
| 4 | (structural) | — | Makes 1 invisible to the ledger | — |
| 5 | A merchant | Nothing — use the cashback flow | A redemption with no public record, and an innocent explanation ready | Nothing, and by design |

Two things fall out of the table:

- **Finding 1 is the only one an honest actor triggers.** Every other row needs
  intent and tooling. That is why it leads the recommendations despite the
  others sounding more cryptographic.
- **Findings 3 and 5 have the same shape**: a merchant *understating* their
  takings. The ledger is built to catch overstating (a fabricated honoured
  coupon) and is largely blind to understating. Whether that matters depends on
  who the audit is *for* — a customer checking their coupon was honoured does
  not care; a party reconciling a stall's declared revenue does.

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

## Finding 1 — the till did not check the coupon is its own

**Severity: high. FIXED — `refuseIfAnotherStalls` in `dmPoll.ts`.**

There were two redemption paths and they disagreed:

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
2. The merchant then publishes a public attestation claiming they honoured it.
   **Be precise about what this inflates.** The attested value is
   `creditableFaceValue(parsed)` — the coupon's *own signed* face value, clamped
   — so the number in the commitment is true. What is false is the *claim of
   entitlement*: the ledger now records stall A honouring a coupon only stall B
   could honour. This is **misattribution**, not a fabricated amount, and an
   earlier draft of this document blurred the two.
3. `redemptionLedger`'s ceiling is per-voucher and local, so the *issuing* stall
   never sees that someone else has been redeeming against their voucher.

Note this is also a **liveness** bug before it is a fraud one: the honest case
(a customer walking to the wrong stall) is more likely than the malicious one,
and it silently costs the merchant money.

**The role model is what makes the fix clean.** A wallet is a customer or a
stall, and never both at once: `merchant.ts` is explicit that an account is a
merchant *"if — and only if"* its key has published a live `imani:merchant`
record, with *"deliberately NO separate role flag"*. A shopper may later
**convert** (Settings → Start selling) but that is a one-way change of role, not
a second role held alongside the first. So there is no legitimate case in which
a stall receives another stall's coupon. Every such arrival is either a customer
at the wrong counter or an attempt to get a coupon credited where it is not
owed.

One edge is worth naming so it is not rediscovered. A stall can switch **Open
for business** off, at which point the docs say its home screen *"goes back to
the shopper view"*. That is a UI change, not a role change: `loadMerchant()`
still returns the record, only `isMerchant()` (which also checks `active`)
says no. The attestation gate in `dmPoll.ts` uses `loadMerchant`, and its
comment defends this — *"a merchant who has closed their stall still has to
attest the coupons they take while winding down."* So a closed stall is still a
stall for the purpose of this check, and the cross-stall refusal should use the
same predicate the attestation gate uses, or the two will disagree about who a
wallet is.

That means the refusal can be unconditional at the till and needs no exception
for a merchant-who-is-also-shopping. It also means the refusal can be **early**
— before the mint swap — which is the point `refuseIfOverRedeemed` already
makes for the ceiling: *"refusing now leaves the token untouched and still the
sender's, and their send reclaims at their next login. The same refusal one
line later would have already taken the money at the mint."* A cross-stall
refusal belongs in the same place, for the same reason.

**The precedent for the fix already exists in this codebase.**
`credentialActor` (`terminalCredential.ts:181`) does exactly this comparison for
terminal credentials, with the same justification: *"A voucher minted by some
other stall, or by the terminal itself, is refused even though its signature is
perfectly valid."*

### How it was fixed, and the bug found while fixing it

`refuseIfAnotherStalls(meta, currentPubkey, token)` runs in `dmPoll.ts`
immediately before `refuseIfOverRedeemed` and before the mint swap. Whose coupon
it is comes before how much is left on it, so the refusal names the real reason
rather than whichever check fired first.

**The first implementation was wrong and would have taken every stall off
subscription.** A licence (ADR 0007) is also a voucher, delivered by the same
gift-wrapped DM, issued by *us* and sent *to* the stall — so its `issuerId` is
never the receiving stall's own key, and the check refused it. That is an outage
strictly worse than the bug being closed: a stall could not renew. `licences.ts`
exists for precisely this hazard and supplies the predicate, which reads signed
`merchant_metadata` a sender cannot forge without breaking `verifyVoucher`.

The licence exception is placed *after* the issuer comparison, so the ordinary
path never pays for the token parse.

`src/lib/__tests__/refuseIfAnotherStalls.test.ts` covers twelve cases at the
function boundary. Mutation tested both ways: removing the check fails 3 tests,
removing the licence exception fails exactly the licence test.

**Those twelve cannot see the property the design rests on.** "Refused before
the mint swap" is a claim about ORDERING, and a unit test on the check does not
have the swap in its frame. So
`src/lib/__tests__/crossStallAdapterOrdering.test.ts` drives the redemption
adapter that `startDmPoll` actually installs, reading it back off the real
`DmPollService`, with a stub standing in for the mint that records every token
it is asked to swap. The assertion is not "it threw" but **"it threw and the
mint was never called"**.

Proved by mutation: moving the refusal to after `redemption.redeem` leaves all
twelve unit tests green and fails exactly one case — the ordering test. Without
it, a regression that burnt the customer's coupon and then refused the
redemption would have shipped with a full green suite.

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

## Finding 5 — the cashback path is a documented omission channel

**Severity: low, and by design — but it changes what `missing` means.**

`cashback.ts:657` calls `redemption.redeem(token, { source: 'cashback' })`
directly, bypassing the DM adapter, and the comment beside it is explicit:
*"Deliberately NOT attested."* The design document lists this as innocent-gap
reason #3.

The reasoning is sound — cashback is not a merchant honouring a claim on
themselves, so an attestation would be a lie. But it has a consequence the
review would be incomplete without:

**Every `missing` verdict now has a known-honest explanation the reader cannot
rule out.** A redemption that went through cashback is, from the ledger's side,
indistinguishable from a merchant who chose not to publish. The `ABSENCE_SLA_MS`
machinery guards against *timing* explanations (the sweep has not run yet); it
cannot guard against *routing* explanations, because the sweep only republishes
rows that carry an `attestationNullifier`, and cashback rows never get one.

So the honest ceiling on `missing` is lower than the technical guide implies.
"Evidence of a gap, not proof of dishonesty" is right; it should also say that
one entire redemption path never writes to the ledger at all.

This is not a bug. It is a fact about what the ledger can and cannot say that
belongs beside the other stated limits.

## Finding 6 — the issuance claim rests entirely on the signing service

**Severity: high, and structural. Not closable inside the wallet.**

A voucher carries **one** signature, and it is the signing service's. The stall
named in `issuerId` signs nothing — established in `issuerAllowlist.test.ts`:
`issuerPublicKey` never equals `issuerId`, and one key signs for two different
stalls.

So *"stall X issued this coupon"* is an **attestation by the service**, not a
statement stall X made. Which raises the question this finding exists for: how
would anyone prove the attested claim is true?

**They cannot, from the coupon.** Whoever holds the service key can mint any
face value in any stall's name, and the result is indistinguishable from a
genuine coupon by inspection. Demonstrated in
`issuerAttestationLimit.test.ts`: a forged 50,000.00 EUR coupon naming a victim
stall verifies clean.

The existing controls do not help, and it is worth being precise about why:

| Control | Why it misses this |
|---|---|
| `verifyVoucher` | Checks the service's signature. The service signed it. |
| `issuerAllowlist` (Rec. 4) | Checks the key is a recognised *service* key. It is — that is the compromise. |
| `refuseIfAnotherStalls` (Rec. 1) | Compares `issuerId` to the stall. It **matches** — the forgery names the victim. |
| The mint | Signs proofs for its own keysets. A compromised issuing service is on the inside of that boundary. |

**What the wallet-side work did and did not buy.** Recommendation 4 closes the
case of a voucher minted by software nobody recognises. It does nothing against
recognised software that has been compromised. Those are different threats and
the review conflated them until this question was asked.

### What would actually close it

A **stall countersignature**: `issuerId` signs the voucher's canonical bytes
with the stall's own key, alongside the service's signature. Then "stall X
issued this" is checkable by anyone holding the coupon, offline, against the
stall's published kind-0 identity — and a compromised service can forge nothing
without also holding the stall's key.

That is a protocol change, not a wallet change, and it has real costs:

- **The stall's key must be present at issuance.** ADR 0009 rejected
  exactly this for automated card purchases: *"which key signs, and where that
  key sits when a card clears at 11pm and nobody is awake"*. A countersignature
  reintroduces that problem for the automated path.
- **`voucherCanonicalBytes` would need a second signature field**, and every
  voucher issued before the change would lack it — so the check has to be
  advisory until an epoch boundary, or it refuses all existing money.
- The terminal-credential flow already has the right shape and could be the
  precedent: authority is a voucher the stall owner minted, locked to a
  device key. The same idea applied to coupons is the fix.

**Interim mitigation, which is what is available today:** the stall's own
`txRecords` are an independent record of what it actually issued, so a stall
can detect coupons attributed to it that it never minted — after the fact,
and only for stalls that look. The v2 attestation issuer commitment (Rec. 5)
makes that reconciliation possible from the public ledger rather than only from
local storage.

**Recommendation: raise this with whoever owns the issuance service.** It is
outside this repo, it is the largest remaining trust assumption in the coupon
model, and it is not visible from the wallet's own code — which is precisely
why it survived a full review until the right question was asked.

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

### 1. Refuse another stall's coupon at the till — **DONE**

Implemented as `refuseIfAnotherStalls` in `dmPoll.ts`, called before
`refuseIfOverRedeemed` and before the mint swap, so a refused coupon stays the
sender's and reclaims at their next login.

Unconditional for a stall, with one exception that had to be discovered rather
than designed: **licences**. See Finding 1 for the detail and for what the first
implementation got wrong.

What this does **not** do: catch a merchant who has modified their client to
skip the check. That needs Recommendation 5.

### 2. Say out loud what `signatureValid` means — **DONE**

`VoucherValidation.signatureValid` now carries the full statement at its
declaration: read it as *internally consistent*, never as *issued by someone I
trust*, with what stands behind it (the mint, ADR 0006's allowlist) and what
does not (anything offline). Pinned by `auditSoundnessLimits.test.ts`.

### 3. State the soundness limit on `verify-total` — **DONE**

`/api/v1/audit/verify-total` now returns a `limits` array beside `verified`,
naming three things a `true` does not mean: set completeness, amount
boundedness, and the cashback routing gap. Kept separate from `note` so a caller
rendering only the headline still sees them.

`/api/v1/audit/coupon/{nullifier}` gained the routing caveat too, since
`missing` is the verdict most likely to be quoted at a merchant and cashback
makes permanent innocent absence possible.

The condition is **boundedness**, not "non-negative": every scalar mod `n` is
non-negative, so that wording named no property at all.

### 4. Pin a coupon issuer key — **DONE, as an allowlist**

`src/lib/issuerAllowlist.ts`, checked in `dmCrypto` beside the signature.

**The recommendation was wrong and measurement said so.** It called for
mirroring `VITE_LICENCE_ISSUER_PUBKEY`: one key, in the bundle. Parsing the
eight real captured tokens in `src/lib/__tests__/fixtures/` shows **four
distinct `issuerPublicKey` values**.

**Why four, and what that does and does not mean.** The obvious explanations
are all wrong, and each is now refuted by an assertion in
`issuerAllowlist.test.ts` rather than by a sentence:

| Hypothesis | Refuted by |
|---|---|
| One key per keyset | All eight tokens share ONE keyset, `00e3372e61d05605` |
| One key per mint | `127.0.0.1.mint` alone accounts for three of the four |
| One key per stall | Stall `b1787b2b…` has coupons under all four |

What the values actually track is the **capture session**: fixtures added in a
single commit share a key, and the same (mint, stall) pair picks up a different
one in a later commit. These are local dev stacks, and the issuer signing key
is regenerated when the stack is rebuilt. So **four is an artefact of this repo
having captured fixtures on four occasions** — it is not a protocol quantity,
and a production deployment may well have exactly one.

That distinction matters, because it changes what the finding is. The data does
not show "there are always several keys". It shows the key is **not a fixed
constant that can be pinned at build time and forgotten** — it belongs to the
issuing side and can be regenerated or rotated. A list costs nothing when there
is one key and is the difference between a working rotation and a flag day when
there is more than one. The test asserts `> 1`, never `=== 4`, precisely
because the count is incidental.

It is also the shape ADR 0006 already specifies for the gateway's own path:
*"(mint, issuer) allowlisted — no, local config"*.

**Unset means ALLOW, the opposite of the licence rule**, and that asymmetry is
deliberate: failing closed on a missing licence key turns a paid feature off,
while failing closed here would turn MONEY off for every deployment that has
not set the variable. A deployment that has not configured this is exactly as
exposed as before and no worse — stated in the module rather than hidden.

### 5. Commit to `issuerId` in the attestation — **DONE, as v2**

`ATTESTATION_VERSION` is now `2`, and the payload carries `issuer`: a hiding
commitment `H(tag | ledgerSk | issuerId | nullifier)`.

**Committed rather than written plainly, and that was measured too.** Stall
pubkeys are public, so the candidate set is enumerable: a plain
`H(issuerId | nullifier)` is brute-forceable, and over a 500-stall list an
observer holding the event recovers the exact issuer immediately — the
nullifier is a public tag, so the only other input is guessable. That would
link a pseudonymous ledger key to a real stall on the first coupon. Mixing the
ledger secret defeats the search while the merchant still reproduces the value.

The nullifier is in the preimage so one merchant's coupons from one supplier do
not share a tag, which would otherwise leak per-counterparty cardinality.

**The reader now separates the version it WRITES from the versions it READS.**
Conflating them is what forces a flag day: every attestation on the relay today
is v1, and a reader accepting only its own version would report the entire
existing stream as `unknown_version` on the day of a deploy — the stream would
look like it had stopped. Deploy the reader before, or with, any wallet that
publishes v2.

### 6. Range proofs — **DONE, as bounded openings rather than Bulletproofs**

`POST /api/v1/audit/verify-openings`, backed by `verifyDisclosedOpenings`.

**The cheap version does not work, and this was measured rather than
reasoned about.** The tempting shape is: range-check each disclosed amount
(free, it is just JavaScript), then do ONE aggregate homomorphic check. An
attacker publishes a commitment behaving as `-6000` and discloses four amounts
that are each perfectly in range and sum to the understated total. Every amount
passes the range test, the aggregate reconciles, and the lie goes through —
because the aggregate never ties an individual commitment to an individual
amount. Asserted in `disclosedOpenings.test.ts` so nobody re-proposes it.

Only a per-commitment opening ties them, at one scalar multiplication each.
Hence:

- `/verify-total` stays, cheap, capped at 500, and now says plainly what it
  does not prove.
- `/verify-openings` is sound, and capped at **50** — derived from the measured
  ~3-4 ms per opening, which keeps a request near 200 ms on a single-threaded,
  public, CORS-open service. Sharing the 500 cap would mean ~2 s per request,
  which is the denial of service the other cap exists to prevent.

No Bulletproofs, no new dependency. The opening also **derives** the total
instead of accepting a claimed one, which removes the "claimed vs actual"
disagreement entirely.

What it still does not prove: completeness. That is unclosable from inside a
disclosure and remains the honest limit.

### Appendix to 6: why "do it async" was the wrong question

**The premise to check first: proving is already off the hot path.**

Nothing in the app calls `blindSumFor`. Its only callers are its own tests and
the audit API's documentation. Disclosure is a deliberate, later, merchant-
initiated act at Settings → Redemption ledger — not part of redemption. So there
is no "long proving time on the till" to move off the till. A range proof would
be generated during a sweep or a disclosure, both of which are already
asynchronous with respect to taking a customer's money.

That reframes the question from *how do we hide the latency* to *what are we
willing to pay, and where*.

**Measured on this machine** (AMD Ryzen 5 7535U, Node 20; warm JIT, median of
many runs) via `scripts/bench-commitments.mts`, which is committed so the
numbers can be re-derived rather than believed:

| Operation | Cost | Dominant work |
|---|---|---|
| `commitTo` (one redemption) | **~3–4 ms** | 2 scalar mults |
| `verifyDisclosedTotal` @ 500 | **~50–60 ms** | 1 scalar mult + 499 additions |
| Per-nullifier openings @ 500 | **~1.6–2.0 s** | 1,000 scalar mults |

Ranges, not point values, deliberately: two consecutive runs on an idle machine
gave 57 ms and 49 ms for the same call. Treat these as **orders of magnitude**.
The ratio is the durable part — openings cost roughly **30–40x** the homomorphic
sum — and that ratio is what the decision turns on.

The homomorphic sum is cheap because point *addition* is far cheaper than
scalar *multiplication*: 500 commitments cost one `commitTo` plus 499 adds.

**This reverses the recommendation in the original draft of this document.**
Per-nullifier openings were proposed as the cheap, sound alternative to
Bulletproofs. They are sound, and they are not cheap: on the order of two
seconds of blocked event loop on a single-threaded Node service that is public,
unauthenticated and CORS-open. Swapping one in for the other at the current
`AUDIT_DISCLOSURE_LIMIT` of 500 would introduce the denial of service the
500-cap exists to prevent.

If openings are adopted, the cap has to come down with them:

| Event-loop budget | Openings per request |
|---|---|
| 50 ms | ~13 |
| 100 ms | ~27 |
| 200 ms | ~54 |

**What openings buy that a proof does not.** Each opening is independent, so the
work is resumable, cacheable per nullifier, and parallelisable. A homomorphic sum
is atomic: 500 commitments or nothing. So the async strategy that actually pays
off is not "compute the proof in the background" but "verify openings
incrementally and cache the verdict per nullifier" — a disclosure is verified
rarely and changes little between verifications.

**Options, honestly ranked:**

1. **Do nothing, document the limit.** Finding 3 needs a *modified publisher*;
   the shipped wallet cannot construct a negative commitment. Recommendation 3
   (state the soundness caveat in the `note`) closes the documentation gap at
   zero cost and is the right first move.
2. **Openings with a much lower cap**, if soundness against a modified publisher
   is wanted without new crypto. Costs the amount privacy of the disclosed set —
   which is already partly given up, since the total is disclosed anyway.
3. **Bulletproofs, generated asynchronously.** Cost is linear in bit width, so a
   32-bit range (max ~4.3bn minor units, far above any real face value) is half
   the work of the usual 64-bit. Publish as a separate event referencing the
   nullifier, and have the reader treat a missing proof as `unproven` rather than
   as a finding — the same discipline `ABSENCE_SLA_MS` already applies to a
   missing attestation. `scannerSupport.ts` is the precedent for a Web Worker.

The performance errors that shaped this section are in the errata (items 2–4).

## Errata: what this review got wrong, and when

Collected in one place, in the order they were caught. Each is left in rather
than quietly removed, in the same spirit as the "review caught it" comments
throughout this subsystem — and because every one of them is an easy mistake
to make twice.

### 1. "Bind `issuerPublicKey` to `issuerId`" — withdrawn

An earlier draft recommended this to fix Finding 2. It is wrong, and the
codebase already knows it. `terminalCredential.ts:149`, established against the
live gateway:

> The issuer here is the voucher's `issuerId`, NOT its `issuerPublicKey`.
> Minting one against the live gateway is what showed the difference:
> `issuerPublicKey` is the GATEWAY's signing key, the same for every voucher it
> mints, so comparing the stall against it refuses every real credential ever
> issued.

So that binding would refuse every genuine coupon. The correct pin is the
**gateway's** key, which is Recommendation 4 and a deployment decision, not a
code change.

### 2. "`/verify-total` takes ~2 s at 500 entries" — wrong by 40x

It is ~50 ms. The 2 s figure was 500 `commitTo` calls, which is a different
operation: `verifyDisclosedTotal` does 499 cheap point *additions* and exactly
one `commitTo`. Extrapolated across two operations that share a name in a
sentence and nothing else.

### 3. "Precomputing `H` gives 7.9x" — no speedup exists

JIT warm-up. noble already caches internally. The same call measured 0.39 ms
and 4.1 ms in two runs on one machine. The "one-line optimisation" was withdrawn
before any code was written.

### 4. "Per-nullifier openings are the cheap sound alternative" — reversed

They are sound, and they cost 30–40x the homomorphic sum. See Recommendation 6.
The original draft recommended them; measurement reversed it.

### 5. "Inflating their own apparent takings with value they never issued" — imprecise

The attested value on a cross-stall redemption is the coupon's *true* signed
face value. What is false is the entitlement, not the number. Finding 1 now
says *misattribution*, which is what it is.

### 6. "A merchant is also a shopper" — wrong, and it was my own invention

A draft of this document, produced while reviewing itself, read the README's
*"you can start selling later if you begin as a shopper"* as meaning a merchant
holds both roles at once, and rewrote Recommendation 1 to carve out a
"merchant-as-shopper" exception. **There is no such case.** `merchant.ts` says
an account is a merchant *if and only if* it has a live stall record, with no
separate role flag; converting from shopper to stall is a change of role, not
an addition. The user corrected this directly.

The consequence runs the other way from what the draft claimed: the fix is
*simpler*, not harder. The refusal can be unconditional at the till and can
happen before the mint swap. Recommendation 1 now says so.

Worth noting how this one happened: I read a sentence in the README, drew an
inference about the role model, and did not check it against `merchant.ts`,
which states the model in one line. The correct source was three files away.

### 7. "Non-negative amount" — wrong condition

Recommendation 3's first wording. Every scalar mod `n` is non-negative; the
missing property is *boundedness*.

### 8. "Unconditional for a stall" — would have blocked every subscription

The implementation of Recommendation 1, written from this document's own
instruction that the refusal could be unconditional. It could not: a **licence**
is a voucher delivered by the same DM path, issued by us and sent to the stall,
so `issuerId` is never the receiving stall's key. The first version refused
every one — a stall could not renew its subscription.

Caught by reviewing the diff against `licences.ts`, whose header describes this
exact hazard for a different feature. The document had asserted a property of
the role model without checking what else arrives through the same door.

### 9. "Mirror the licence key" — refused by the real tokens

Recommendation 4 as written. Parsing the captured fixtures shows four distinct
`issuerPublicKey` values, so a single pinned key would have refused genuine
coupons. Built as an allowlist instead.

The same root cause as errata item 1: both came from treating
`issuerPublicKey` as a constant without checking.

### 9a. "…varying by mint and keyset" — the explanation was also wrong

Having found four keys, the first write-up explained them as per-mint and
per-keyset. **Both are false**, and the user asking *why exactly four* is what
prompted checking rather than re-asserting: all eight tokens share ONE keyset,
and one mint accounts for three of the four values. The keys track capture
sessions on rebuilt dev stacks.

The correction does not change the design — an allowlist is still right, for the
weaker and more accurate reason that the key is not a pinnable constant — but
it changes what the evidence supports, and a design resting on a stated reason
should rest on a true one. Three hypothesis-refuting assertions now sit in
`issuerAllowlist.test.ts` so the claim cannot drift back.

### 9b. "The gateway's key, the same for every voucher it mints" — false, and it was load-bearing

Asked whether `issuerPublicKey` is the merchant's key. It is not — but checking
that turned up a stronger result, and exposed a wrong claim that had been
sitting in `terminalCredential.ts` since long before this review and that
**errata item 1 had quoted as authority**.

That comment said the field is "the GATEWAY's signing key, the same for every
voucher it mints". The fixtures refute the second half: one stall's coupons
carry four different keys, and the value changes when a dev stack is rebuilt.

What the data does establish is sharper than either claim, and it answers the
original question definitively:

| Observation | Consequence |
|---|---|
| `issuerPublicKey` never equals `issuerId`, on any token | It is not the stall's key |
| One key signs for **two different stalls** | It cannot be *any* stall's identity |
| One stall's coupons carry four keys | It is not per-stall |

So the structure is **"the issuing service attests that stall X issued this
coupon"**, not "stall X signed this coupon". `issuerId` is the stall, and it
lives *inside* the bytes the service signs — which is why it is trustworthy
without being the signer, and why `credentialActor` was right to compare it.

The two fields answer different questions, and conflating them caused two of
the eleven errata:

- `issuerId` — **which stall is this coupon a claim on?**
- `issuerPublicKey` — **whose software minted it?**

Both are now asserted in `issuerAllowlist.test.ts` rather than described.

Worth noting the shape of this one: the original comment was *right about what
to do* and wrong about why, and the wrong reason survived because it was never
tested. It then propagated into this review as a quotation. A false premise
that produces a correct decision is the hardest kind to catch.

### 10. "Write `issuerId` into the attestation" — would have de-anonymised every stall

The obvious form of Recommendation 5, and the review nearly specified it that
way. Stall pubkeys are public, so a plain hash over a public issuer and a
public nullifier is brute-forceable — measured over a 500-stall list, the
issuer falls out immediately. Salted with the ledger secret instead.

### 11. "Range-check the amounts, then one aggregate check" — not sound

The cheap form of Recommendation 6, which the document itself floated. An
attacker discloses in-range amounts that sum to the lie while one commitment
behaves as a negative: the range test passes, the aggregate reconciles, and
nothing catches it. Only per-commitment openings tie a commitment to an amount.

### 12. "It needs a stall countersignature" — the right finding, the wrong fix

Finding 6 is correct and was confirmed independently. The **remedy** attached
to it was not, and the gateway team said so.

A countersignature proves *stall X authorised this* and says nothing about
*what was received for it*. But re-read our own attack: the harm is not that a
coupon names the wrong stall, it is that a 50,000 EUR **claim** exists against
a stall that was never paid 50,000 EUR. The countersignature authenticates the
debtor and leaves the amount entirely to whoever holds the signing key.

Worse, the evidence was already in our own handoff. §5 conceded the
countersigning key would not be the stall's root key but a terminal lock key on
an always-on service. We wrote that down and did not follow it: it swaps a
compromise we defend against for one we do not, shrinking blast radius from all
stalls to one while leaving the **amount unbounded**. The concession refuted
the proposal and we did not notice.

The failure was in the **question**. We asked "who authorised this", and that
question has exactly one natural answer, so the design space closed before it
opened. The better question was "what, outside our trust boundary, says this
was authorised" — which admits a payment processor, and with it a forgery that
**pays the victim** to execute.

Two things would have caught it. Following our own §5 concession one step
further, as above. And reading `application.yml`: `/api/v1/cash` sits under
`nip98-protected`, so the merchant's key was *already signing* every cash
issuance and the gateway was discarding the `sig`. We spent the handoff arguing
ADR 0009 put that key out of reach, while on the cash path it was in the loop
the whole time. Item 9b was the same mistake against the same repo: asserting
the shape of the issuance side without reading it.

**Pattern across all twelve:** every error came from reasoning one step past
what had been measured or read. Items 2–4 came from single-shot timing on a
cold VM and are why `scripts/bench-commitments.mts` warms hard and takes
medians. Items 1, 5, 7 and 9 came from not re-reading a nearby comment, my own
sentence, or the data. Items 6 and 8 came from reading one document and not the
module that defines the thing it describes — 6 was caught by the user, 8 by
reviewing the diff. Items 9–11 were caught by MEASURING the recommendation
before implementing it, which is the only reason three of the six shipped in a
different shape than they were written. Item 12 is the first caught by someone
else, and it is the most expensive kind: the finding was right, the fix was
wrong, and the refutation was sitting in our own §5. None survived a second
look. Whoever extends this document should assume the same rate applies to
them — and should note that item 12 was only found because the handoff was
written to be checkable rather than persuasive. Send the reasoning, not just
the conclusion, to someone who owns the code you are reasoning about.
