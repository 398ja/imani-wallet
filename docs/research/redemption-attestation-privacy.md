# Pseudonymous redemption attestations

Design for kan.bn `ro89whflu3br`, against the requirement as stated:

> For any merchant one can fetch the attestations to audit the sales/numbers,
> possibly without knowing which merchant it is.

Replaces an earlier option survey in this file (see git history, `9f79ff3`),
which weighed five approaches before the requirement was clear. With it stated,
the choice is settled and only the design below remains.

Every claim here was checked by running it against the repo's existing
`@noble/curves` — see *Verification*.

## What an admin can and cannot do

| Question | Unaided? |
|---|---|
| Fetch one merchant's whole set | **Yes** — `{ authors: [ledgerPub] }` |
| Is each attestation authentic? | **Yes** — BIP-340, same scheme as voucher signatures |
| Was a token redeemed twice? | **Yes** — duplicate nullifier |
| How many redemptions in a period? | **Yes** — cardinality |
| What was each amount? | **No** — commitments |
| What was the period total? | **Only on disclosure** — and then unforgeably |
| Which real merchant is this? | **No** — unless they link it |

The disclosure step is the important one: it is not "trust the merchant's
number". Once commitments are published, a claimed total either reconciles
against them or does not. Verified: a merchant understating (4000) and
overstating (5000) both fail against a true total of 4500.

## The three problems, kept apart

Conflating these is easy and was the main error in the earlier draft.

1. **Access** — who may read the relay. NIP-42 (`serviceUrl`) answers this.
2. **Authorisation** — which events a reader may see. strfry's
   `restrictReadToInvolvedPubkey` answers this, and is **the wrong control
   here**: it would enforce "read only what you are a party to", which forbids
   the third-party audit this feature exists for.
3. **Disclosure** — what a *legitimate* reader learns. Only the payload
   decides this. An auditor is authenticated by definition; access control
   cannot protect against the reader you are deliberately admitting.

Pseudonymisation is problem 3. It is a property of the payload, not the
transport.

## The design

### Ledger key — a pseudonym that is also a fetch handle

```
ledgerSk  = H("imani-ledger-v1" | merchantSk)
ledgerPub = schnorr.getPublicKey(ledgerSk)
```

Attestations are signed by `ledgerSk`, so `{ authors: [ledgerPub] }` fetches
exactly one merchant's set — the stated requirement — while `ledgerPub` is not
the merchant's identity key.

**Derive from the merchant's SECRET, not their pubkey.** A plain hash of the
public identity key is reversible by anyone holding a coupon: `issuerId` is
signed inside every voucher, so an observer computes the same hash and the
pseudonym is broken. Verified: the attacker's computed id matches exactly when
derived from public input, and cannot match when a secret is mixed in.

Publishing the event *is* signing the claim — `event.pubkey` and `event.sig`
are the attestation. No second signature layer.

### Nullifier — double-spend detection without identity

```
nullifier = H("imani-redeem-v1" | token_id | proof_secret)
```

Two details, both of which the card's current wording gets wrong:

- **`token_id`, not `voucher_id`.** A £10 voucher legitimately returns as £4
  then £6 — `redemptionLedger.ts` states that tokens legitimately share a
  `voucher_id`, and splits preserve voucher identity byte-for-byte. Keying on
  `voucher_id` therefore **collides on an honest partial redemption** and
  reports a false double-spend. `token_id` is `sha256(token)`, content-derived,
  and already the tombstone key.
- **Bind to the proof secret.** `token_id` is derivable by anyone who has held
  the coupon, so a tag from ids alone can be **pre-published by an attacker** to
  frame an honest redemption as a replay. The proof secret is burnt at the mint
  and never leaves the wallet.

### Amounts — Pedersen commitments with DERIVED blinding

```
r_i = H("blind" | ledgerSk | token_id)      // derived, not random
C_i = amount_i * G + r_i * H
```

Deriving `r` rather than storing it is what makes self-audit survive a device
wipe: the merchant reconstructs every blinding factor from their key alone.

Commitments also defeat the amount-fingerprint attack. With cleartext amounts,
a customer who bought for exactly 2,500 at 09:14 finds that record and unmasks
the pseudonym permanently — one counterparty breaks it for everyone. Verified:
recomputing a commitment from a known amount does **not** match any published
one, because the blind is secret.

## Can a merchant audit themselves?

Yes, and on a new device holding only their key. Verified end to end:

1. Re-derive `ledgerSk` → same `ledgerPub`
2. Fetch own attestations by author
3. Re-derive each `r_i` and re-open each commitment — each published `C`
   reproduces exactly
4. Sum for their own totals

They cannot open anyone else's: substituting their own key produces a
different commitment for the same amount.

**Completeness check.** Local rows are the source of truth
(`redemptionLedger.ts`), so reconciliation is a set-difference on nullifiers:

- local row with no attestation → a publish was lost; republish
- attestation with no local row → wiped device, or someone else publishing
  under this ledger key

This needs no amounts, so a third party can check completeness of the *set*
without reading any value.

## The honest limit: omission

A merchant who redeems four coupons and publishes three produces a ledger that
is authentic, duplicate-free and internally consistent. Nothing inside it
reveals the fourth.

This is not a weakness of pseudonymisation — a cleartext ledger has exactly the
same hole. You cannot see what was never written.

What closes it is already in the system: **the mint**. Redemption burns proofs
and NUT-07 checkstate reports `SPENT`. A coupon spent at the mint with no
corresponding attestation is an unreported redemption, and the comparison needs
no cooperation from the merchant.

> The mint is the completeness oracle; the ledger is the detail. Neither alone
> is sufficient, and any audit procedure should say so.

## Residual leaks

Not fixable by cryptography; traded by batching and rotation.

| Leak | Mitigation | Cost |
|---|---|---|
| Cardinality — a busy stall is visibly busy | none meaningful | — |
| Timing — trading hours and rhythm | batch (e.g. daily) | freshness |
| Longevity — a long-lived pseudonym accumulates a profile | rotate per epoch | cross-epoch audit needs merchant linkage |
| Unit — a rare currency identifies | scope the ledger per unit | fewer, larger anonymity sets |

## Verification

Everything above was executed, not reasoned about:

- ledger key derivation is deterministic, and unguessable from public identity
- attestations verify under `ledgerPub`
- nullifiers collide on replay, differ on legitimate partial redemption
- commitments hide amounts against a known-amount search
- homomorphic sum verifies a true total and rejects both an understated and an
  overstated one
- a merchant re-opens their own commitments from their key alone, and cannot
  open another's

No new dependency: `@noble/curves` and `@noble/hashes` are already used
directly by `voucherToken.ts` for signature verification.

## The audit service — internal and external

The attestations are the data; the service is the product. Both readers are
served by **one published stream** — the difference is not what is published,
it is what each reader can *open*.

| Capability | Internal | External |
|---|---|---|
| Verify an attestation is authentic | yes | yes |
| Detect a token redeemed twice | yes | yes |
| See the stream is live, count redemptions | yes | yes |
| **Confirm a specific coupon was honoured** | yes | **yes** |
| Read one merchant's totals | yes | only on that merchant's disclosure |
| Identify the real stall behind a pseudonym | yes | no |
| Cross-merchant analytics | yes | no |

Internal gets more through a **disclosure granted at onboarding** — one signed
statement linking `ledgerPub` to the stall — not through a second privileged
feed. One stream, one format, nothing to keep in sync.

### The trust moment

The row that sells this is *"confirm a specific coupon was honoured"*, and it
works for the customer themselves. A customer held the token, so they alone can
recompute its nullifier and look it up:

- present in the ledger → **the stall really did redeem my coupon, and I
  checked it myself against a public record**
- absent → evidence, rather than a support ticket that ends in "we cannot see
  it"

Nobody else can compute that nullifier, so the check proves possession without
revealing the amount or the merchant to anyone else reading the stream.
Verified.

That is the difference between *"trust us, we are honest"* and *"do not trust
us — here is the receipt, verify it yourself"*. The second is the selling
point, and it is only credible because the merchant cannot quietly rewrite
history: the commitment is published before any dispute.

### Build it fresh

The existing `cashu-ledger` repo is marked **Retire** on its own board: it
traverses a voucher parent-child DAG that never had edges (every call site
passed `null`), and the one site that did pass a parent fabricated children
whose signatures could not verify. Its CLI, core and web are all organised
around that graph.

The replacement reader is a `GROUP BY` over a flat attestation stream, not a
graph walk. Build against the stream; do not revive the traversal.

## Open decisions

1. **Batching interval.** Per-event publication leaks trading rhythm even with
   an opaque payload. Daily is the obvious default.
2. **Epoch rotation.** Worth it only if long-term profiling is a real concern;
   it complicates multi-period audit.
3. **Who may read the ledger at all.** The requirement says broadly readable,
   so probably nobody — but that should be a decision, not a default.
4. **Ledger completeness vs the mint.** The mint prevents double-spend in the
   *sats* layer; it has no concept of a voucher, so it cannot see a merchant
   crediting 1,800 XAF against a 2,500 XAF coupon — both burn 2,500 sats
   identically. The ledger makes the *voucher* layer inspectable. Neither is
   redundant, and an audit procedure should use both: the mint for "was it
   really spent", the ledger for "was it credited correctly".
