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
  overstated one **over the disclosed set**. It does NOT bind the merchant to a
  period: they choose which nullifiers to disclose, and omitting one reconciles
  perfectly at a lower total. Set completeness must come from elsewhere — for
  instance a counterparty presenting a nullifier missing from the disclosure.
  An earlier draft of this document and of `blindSumFor`'s comment claimed the
  stronger property; a review caught it
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
| **Confirm a specific coupon was honoured** | yes | **blocked — see below** |
| Read one merchant's totals | yes | only on that merchant's disclosure |
| Identify the real stall behind a pseudonym | **not built** | no |
| Cross-merchant analytics | **not built** | no |

Internal was to get more through a **disclosure granted at onboarding** — one
signed statement linking `ledgerPub` to the stall — not through a second
privileged feed. One stream, one format, nothing to keep in sync.

> **That disclosure does not exist.** Nothing produces, stores or consumes it,
> so the internal reader is today byte-for-byte identical to the external one.
> Caught by the spec axis of the code review; filed as `i41dcl4gk6dd`, where the
> first question is whether it should be built at all — a stored
> `ledgerPub → stall` mapping is the single artefact whose breach
> de-anonymises every merchant at once, which is the same shape of risk this
> design rejected dual-encryption for.

### The trust moment

The row that sells this is *"confirm a specific coupon was honoured"*, and it
works for the customer themselves. A customer held the token, so they alone can
recompute its nullifier and look it up:

- present in the ledger → **the stall really did redeem my coupon, and I
  checked it myself against a public record**
- absent → **not yet evidence.** See the warning below: until the
  reconciliation sweep exists, a gap and a dishonest merchant are
  indistinguishable

Nobody else can compute that nullifier, so the check proves possession without
revealing the amount or the merchant to anyone else reading the stream.
Verified.

That is the difference between *"trust us, we are honest"* and *"do not trust
us — here is the receipt, verify it yourself"*. The second is the selling
point, and it is only credible because the merchant cannot quietly rewrite
history: the commitment is published before any dispute.

> #### ⚠️ The customer cannot do this today, and the blocker is in the gateway
>
> **"A customer held the token" is false on the atomic-send path**, which is
> every coupon a customer sends. Established while building the reader:
>
> - `nullifierFor` hashes the token the merchant **received** (`dmPoll.ts`), and
>   that token is the gateway's `send_token`, produced by the split and handed
>   straight to the gift wrap (`AtomicSendService`).
> - `AtomicSendResponse` states it outright: *"The send_token is NEVER returned
>   during the saga — it stays server-side. Only returned via reclaim."* The
>   customer receives `keep_token`, which is their **change**.
>
> So the customer's wallet never sees the bytes that were redeemed and cannot
> compute the nullifier to look up. `couponCheckFilter` is unreachable in
> principle, not merely uncalled — its own comment attributes this to sequencing,
> which is now known to be the lesser reason.
>
> **The fix is small and belongs to the gateway:** return the send token's
> *nullifier* (not the token) to the sender on COMPLETED. It is a hash of a
> value the gateway already holds, discloses nothing bearer, and is the only
> thing standing between here and the headline capability. Filed as its own
> card.
>
> Everything else in this table — authenticity, replay detection, per-merchant
> audit, the merchant's own view — is built and live.

### Absence is not evidence, and the SLA that makes it mean something

**The reconciliation sweep now exists** (`reconcileAttestations`, reachable at
Settings → Redemption ledger). Before it did, a missing attestation had at least
four innocent explanations, and the ledger could not tell them apart from a
merchant omitting deliberately:

1. the tab closed before the publish landed
2. the relay rejected or dropped the event
3. the redemption came through a path that does not attest (the cashback flow
   calls `redemption.redeem` directly)
4. the coupon carried no verified issuer claim, so there was correctly nothing
   to attest

A customer-facing check that reports "this stall has no record of your coupon"
on any of those is a false-accusation generator, and it would damage exactly
the trust the feature exists to build. **The producer shipping before the sweep
is fine; the customer-facing interpretation shipping before the sweep is not.**

Order of work: producer → reconciliation sweep → reader. Not producer → reader.

**The reader now gates absence on a one-hour SLA** (`ABSENCE_SLA_MS` in
`src/lib/audit.ts`), which is the operational form of the rule above. Inside the
hour a gap reads `pending` and says when that may change; past it, `missing` —
and `missing` travels with a written caveat that it is evidence of a gap and not
proof of dishonesty. A caller that cannot say *when* the redemption happened
cannot obtain a `missing` verdict at all: no timestamp, no accusation.


### Build it fresh

The existing `cashu-ledger` repo is marked **Retire** on its own board: it
traverses a voucher parent-child DAG that never had edges (every call site
passed `null`), and the one site that did pass a parent fabricated children
whose signatures could not verify. Its CLI, core and web are all organised
around that graph.

The replacement reader is a `GROUP BY` over a flat attestation stream, not a
graph walk. Build against the stream; do not revive the traversal.

## What shipped (DEV-245)

The reader is `src/lib/audit.ts`, and it is the whole service's logic: verify a
signature, detect a replay, answer "was this coupon honoured", summarise one
ledger key. It needs no key and no wallet, so **one implementation** serves an
external auditor, the hosted API and a merchant auditing themselves — an
external reader cannot be told something an internal one would not be.

| Surface | Where |
|---|---|
| Reader | `src/lib/audit.ts` |
| Hosted API | `services/audit-api/` → `audit.staging.398ja.xyz` |
| Merchant's own view | Settings → Redemption ledger |
| Dashboard | Grafana → *Redemption audit ledger* |
| Live probe | `scripts/audit-probe.mjs` |
| Independent verifier | `scripts/verify-attestations.py` (shares no code) |

### The disclosure check is reachable

`POST /api/v1/audit/verify-total` with `{nullifiers, total, blindSum}` answers
the *"read one merchant's totals — only on that merchant's disclosure"* row.
Needs no key, which is what makes it an audit rather than a favour.

It was very nearly shipped as a promise rather than a capability:
`verifyDisclosedTotal` and `commitTo` were correct, tested, and called by
**nothing but their own tests**, stranded inside the signing module where the
hosted service could not import them. They now live in the reader with the other
key-free checks, and `attestation.ts` re-exports them so merchant-side callers
are unchanged.

Verified against the live relay: a true total of 4000 over two published
commitments verifies; understating (3000) and overstating (5000) are both
rejected. The response carries the caveat that a `true` binds the disclosed SET
and not a period — the merchant chooses what to disclose, so omission
reconciles at a lower total.

Three findings worth carrying forward, each from running the thing rather than
reasoning about it:

- **`verifyEvent` can be fooled by object spread.** nostr-tools memoises its
  verdict in a `Symbol(verified)` property, and symbols survive spread — so
  `{...genuine, sig: 'ff…'}` verifies `true` without the signature being
  checked. Relay traffic arrives as JSON and so was never at risk, which is why
  it could sit unnoticed. `stripCachedVerdict` removes it before every check.
- **A batched event is already on the relay.** Event `6a3688bf…` carries two `n`
  tags and no `v`, from this design work. An absent version defaults to v1, so
  batches are refused structurally as well as by version.
- **A missing WebSocket transport returns zero events from a *successful*
  query.** In a Node service that reads as "no redemptions" rather than as an
  outage — the API would have accused every merchant of not publishing. Guarded
  in `/health`.

Measured against staging: 30 events, 28 audit cleanly, 2 refused correctly (the
hand-made probe above and the batch), across 9 ledger keys in EUR and XAF.

## Open decisions

1. ~~**Batching interval.**~~ **Decided: one event per redemption for now.**
   Per-event publication leaks trading rhythm even with an opaque payload, and
   batching would fix that — but a customer cannot verify a coupon that has not
   been published yet, so the trust check would go from instant to next-day.
   The instant check is the feature; the timing leak is the price.

   Revisit if per-merchant rhythm turns out to matter. The migration is cheaper
   than it looks on the half that matters: a batched event carries one `n` tag
   per nullifier and relays match `#n` against all of them, so the customer
   check survives untouched (verified against the staging relay). Only the
   auditor's reader would need to handle both content shapes — so build it to
   accept a list from the start.
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
