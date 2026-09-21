# Handoff: a coupon cannot prove which stall issued it

**To:** the team owning the voucher issuance path (`cashu-voucher`, and the
gateway that calls it)
**From:** the `imani-wallet` side, out of an audit of the redemption attestation
ledger
**Status:** open finding, no wallet-side fix available
**Full context:** `docs/research/audit-double-spend-inflation-review.md`,
Finding 6

---

## 1. The finding in one paragraph

A voucher carries **exactly one signature**, and it belongs to the signing
service. The stall named in `issuerId` signs nothing. So a coupon asserts *"the
service says stall X issued this"* and carries no evidence that stall X did.
Anyone holding the service's signing key can mint **any face value in any
stall's name**, and the result is byte-for-byte indistinguishable from a genuine
coupon to every verifier we have. The stall being impersonated has no way to
detect it at redemption time, and no way to disprove it afterwards.

This is not a bug in anyone's code. Every component behaves as written. It is a
property of the trust model that we believe was never stated explicitly, and it
is the largest remaining assumption in the coupon scheme.

---

## 2. How we got here, so you can check our reasoning

The wallet-side review started from a different question (can the audit ledger
detect double spends?) and reached this by asking what `issuerPublicKey`
actually is. Three observations, from the **eight real captured tokens** in
`imani-wallet/src/lib/__tests__/fixtures/*.token`:

| Observation | Consequence |
|---|---|
| `issuerPublicKey` never equals `issuerId`, on any token | It is not the stall's key |
| One key (`4b22d0ec…`) signs vouchers for **two different stalls** | It cannot be *any* stall's identity |
| One stall (`b1787b2b…`) has coupons under **four different keys** | It is not per-stall either |

The middle row is the decisive one. A key that signs for two different stalls is
a **service** key by definition.

We also ruled out the explanations that would have made the key derivable from
something stable:

- **Not per-keyset.** All eight tokens share one keyset, `00e3372e61d05605`.
- **Not per-mint.** `127.0.0.1.mint` alone accounts for three of the four keys.

These are asserted as tests, not claims:
`imani-wallet/src/lib/__tests__/issuerAllowlist.test.ts`.

**Please sanity-check this against your own records.** Our fixtures are captured
from local dev stacks, and while the structural conclusion does not depend on
that, the *number* of distinct keys does. If production issues under a single
long-lived key, that changes the operational picture below but not the finding.

---

## 3. The attack, concretely

`imani-wallet/src/lib/__tests__/issuerAttestationLimit.test.ts` builds this and
asserts every step.

1. Attacker obtains the issuance service's signing key — through a service
   compromise, a leaked backup, a malicious insider, or a supply-chain
   compromise of the signing component.
2. Attacker mints a voucher with `issuerId` set to a **real, unrelated stall**
   and `faceValue` set to anything: we used 50,000.00 EUR.
3. Attacker signs it with the service key. `issuerSignature` is genuine.
4. Coupon is delivered to a customer by the ordinary gift-wrapped DM path.

Every verifier we have says yes:

```
verifyVoucher(forged).signatureValid  ->  true
forged.issuerId                       ->  the victim stall
forged.issuerPublicKey                ->  the service key (which really signed)
```

The customer believes they hold a 50,000.00 EUR claim on the victim stall. The
victim finds out when it is presented at their counter.

### Why each control we have misses it

| Control | Where | Why it does not fire |
|---|---|---|
| `verifyVoucher` | wallet | Checks the service's signature. The service signed it. Valid. |
| Issuer allowlist | wallet, new | Checks the key is a **recognised service key**. It is — that is what compromise means. |
| `refuseIfAnotherStalls` | wallet, new | Compares `issuerId` to the receiving stall. It **matches**: the forgery names the victim. |
| Redemption ceiling | wallet | Bounds redemptions against the voucher's own signed `faceValue`, which the attacker chose. |
| The mint | server | A compromised issuing service sits **inside** the mint's trust boundary, not outside it. |

The wallet-side hardening we shipped alongside this review closes *"a voucher
minted by software nobody recognises"*. It does nothing about *"recognised
software that has been compromised"*. We had conflated those two until this
question was asked directly, and we want to be clear we are not claiming the
wallet work addresses this.

---

## 4. Blast radius

What an attacker with the service key can do, in rough order of severity:

1. **Mint unlimited value in any stall's name.** No cap exists that is not
   itself inside the signed bytes.
2. **Do it retroactively-plausibly.** `issuerId`, `faceValue`, `expiresAt` and
   `merchantMetadata` are all attacker-chosen, so the coupon can be made to look
   like part of a normal issuance run.
3. **Target a specific stall.** Nothing rate-limits or scopes which `issuerId`
   the service will sign for.
4. **Mint terminal credentials.** The same signature covers
   `merchant_metadata` carrying `stall_pubkey`, `role` and `lock_key` — so the
   same key can forge an authorisation to act for a stall. `credentialActor`
   defends itself by comparing the voucher's `issuerId` against the metadata's
   `stall_pubkey`, and a forger supplies **both**, so they agree.

   Verified, not inferred. `issuerAttestationLimit.test.ts` builds a forged
   credential and asserts what it grants:

   ```
   verifyVoucher(credential).signatureValid  ->  true
   credentialActor(...)                      ->  role = issue-and-redeem
                                                 stall = the victim
                                                 perms = voucher:issue:<victim>,
                                                         voucher:redeem:<victim>
   ```

   So a service compromise is an **authorisation** incident as well as a minting
   one: the attacker holds a credential to issue *and* redeem for a stall that
   authorised nothing, locked to a device key they generated.

### What limits it today

- The **mint** still has to swap the proofs. A forged voucher needs valid mint
  proofs, so the attacker needs the issuance path to actually mint — which it
  does, since it is the service.
- A stall's own `txRecords` are an independent record of what it really issued,
  so misattribution is **detectable after the fact** by a stall that looks.
- Nothing is in production yet, as we understand it. This is the cheapest moment
  to change the format.

---

## 5. What would close it: a stall countersignature

The stall signs the voucher's canonical bytes with its own key, alongside the
service's signature.

```
issuer_sig        (existing) — the service attests it minted this
stall_sig         (new)      — the stall attests it authorised this
```

A verifier then checks `stall_sig` against `issuerId` directly. `issuerId` is
already a Nostr pubkey and stalls already publish a kind-0 under it, so the
verifying key needs no new distribution mechanism and the check works
**offline**, which the design already requires elsewhere.

A compromised service can then forge nothing on its own. It would need the
stall's key as well, and that key lives on the stall's own device.

### The hard part, which we do not want to hand-wave

**This collides directly with ADR 0009.** That decision considered requiring the
stall's key at issuance and rejected it, in these words:

> automatic issuance is not a question of which endpoint to call, it is a
> question of **which key signs, and where that key sits** when a card clears at
> 11pm and nobody is awake.

A countersignature reintroduces exactly that problem for the automated card path.
We do not think that kills the idea, because ADR 0009 also supplies the shape of
the answer: the **Purchase Issuer** already holds a per-stall terminal
credential, locked to a key the terminal generated, minted by the stall owner.

So the countersigning key need not be the stall's root key. It could be the
terminal credential's lock key, with the chain being:

```
stall root key  --signs-->  terminal credential (lock_key K)
K               --signs-->  the voucher
```

That is a real improvement over the status quo even though it does not reach the
root key, because the stall *chose* to delegate to K and can burn it. A verifier
would check the credential chain rather than a single signature. Whether that is
worth the complexity versus a simpler scheme is your call — you own the
constraints we do not see.

### Migration

Our reader has a precedent for exactly this and it was painful, so it is worth
naming: `getCanonicalBytesForSigning` once truncated every number through
`longValue()`, which meant `issuance_ratio` was effectively unsigned on every
voucher issued before the fix. The wallet still carries a two-step verify
(`VoucherSignatureService.verify`'s current form, then the legacy form) because
those vouchers are live and cannot be re-signed.

Please avoid repeating that shape. Suggested sequencing:

1. **Add `stall_sig` as an optional field** and have `VoucherCanonicalBytes`
   exclude it from the signed bytes, exactly as `issuer_sig` and `issuer_pubkey`
   are excluded today.
2. **Publish the format change** so verifiers can read it before any producer
   writes it. Our reader refuses unknown shapes rather than mis-parsing, which
   is safe but means a producer ahead of its readers looks like an outage.
3. **Issue with it, verify advisorily.** Record presence and validity; do not
   refuse on absence.
4. **Flip to required at an epoch boundary**, once the population of
   uncountersigned vouchers has expired naturally.

If you are confident nothing is in production, steps 2–4 collapse and you can
simply require it. We would rather over-explain the migration than assume that.

### Versions in play

Per ADR 0006, these are pinned as a set in `imani-bom` and must not be mixed:

| | version | contributes |
|---|---|---|
| `cashu-lib` | 0.29.0 | defines the composite NUT-10 kind |
| `cashu-voucher` | 0.13.0 | signs it |
| `cashu-mint` | 0.35.0 | enforces voucher conditions and the P2PK witness |

A countersignature most likely lands in `cashu-voucher` with a
`VoucherCanonicalBytes` change in `cashu-lib`, which by the BOM's own rule means
all three move together.

---

## 6. Alternatives, if a countersignature is too expensive

We are not close enough to your constraints to recommend between these, so they
are listed with what we think each buys.

**A. Issuance log, published and append-only.** The service publishes a signed
record of every voucher it mints, per stall. A stall reconciles it against their
own `txRecords`. Does not prevent forgery, makes it **detectable by the victim**
without needing the attacker to present the coupon. Cheap. Does not survive an
attacker who controls the log too.

**B. Per-stall signing keys.** Rather than one service key, the service holds a
distinct key per stall, and a stall's key is derived or registered at onboarding.
Compromise of one key affects one stall. Reduces blast radius, does not close the
finding. Note our fixtures show the opposite of this today — one key serving two
stalls.

**C. Threshold or HSM-held signing key.** Standard key-custody hardening. Lowers
the probability of compromise; changes nothing about what a compromise achieves.

**D. Rate and scope limits on the signing path.** Refuse to sign an `issuerId`
that has not recently authenticated, or above a per-stall velocity. Reduces the
practical damage of a live compromise. Does nothing against an attacker holding
the key offline.

Our view: **A is the cheapest meaningful step** and is complementary to a
countersignature rather than a substitute. **B and D reduce blast radius.** Only
a countersignature actually makes the claim provable.

---

## 7. What we have done on the wallet side

So you know what you are integrating with, and what has changed under you:

- **Issuer allowlist** (`src/lib/issuerAllowlist.ts`). Opt-in via
  `VITE_VOUCHER_ISSUER_PUBKEYS`, comma-separated. Refuses vouchers signed by an
  unrecognised key. **Unset means allow**, deliberately, so it cannot strand
  money on an unconfigured deployment. This does not address the compromise case
  — see §3.
- **Cross-stall refusal** (`refuseIfAnotherStalls` in `src/lib/dmPoll.ts`).
  A till refuses a coupon whose `issuerId` is not its own stall, before the mint
  swap so the coupon stays the sender's. Licences are exempt, since they
  legitimately arrive from another issuer.
- **Attestation v2** (`ATTESTATION_VERSION = '2'`). The public redemption
  attestation now carries a hiding commitment to the issuing stall, so a stall
  redeeming coupons it never issued is visible in the ledger on disclosure. The
  commitment is salted with the merchant's ledger secret because a plain hash
  over a public stall pubkey is brute-forceable.

The v2 change is the one most likely to matter to you: **any reader of the
kind-7377 stream must be updated before wallets publish v2**, or it will report
the stream as `unknown_version`.

---

## 8. What we would like from you

1. **Confirm or correct the model.** Is `issuerPublicKey` a single long-lived
   service key in production, or several? Our fixtures say four, but they are
   from dev stacks and we would rather have your answer than our inference.
2. **Tell us whether a stall countersignature is viable**, given ADR 0009's
   constraint. If not, we would like to understand what you would do instead, so
   the wallet's documentation stops implying a guarantee that does not exist.
3. **A decision we can record**, either way. If this is an accepted risk for the
   current stage, that is a legitimate answer and we will write it down as such
   rather than leaving it as an open finding.

We are happy to be wrong about any of this. Everything above is reproducible
from the tests named, and if a check we do not know about already closes it we
would genuinely like to hear so.

---

## 9. Reproducing our results

```bash
# in imani-wallet
npx vitest run src/lib/__tests__/issuerAttestationLimit.test.ts   # the forgery
npx vitest run src/lib/__tests__/issuerAllowlist.test.ts          # the key structure
```

The fixtures are real captured tokens, not synthetic:
`src/lib/__tests__/fixtures/*.token`.

Full audit, including four other findings and an errata list of the eleven
things this review itself got wrong:
`docs/research/audit-double-spend-inflation-review.md`.
