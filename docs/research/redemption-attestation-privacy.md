# Redemption attestations without exposing per-merchant volume

Design options for kan.bn `ro89whflu3br` — *Public redemption attestations
alongside the sealed kind-7376 records*. The card ends with an unresolved
question: *"Public attestations expose per-merchant redemption volume to
competitors. Confirm that trade is acceptable before shipping."*

This document answers it. **Yes, it can be achieved without that exposure** —
but which option is right depends on a question the card does not state, and
that question has to be settled first.

## The leak, stated precisely

The card proposes publishing `{ voucherId, amount, merchantPubkey, timestamp }`
per redemption. That is worse than "volume". A merchant publishes a kind-0
profile, so their pubkey is already tied to a stall name. An observer with only
the public attestations can compute, per named stall:

- revenue per day, and the trend across days
- transaction count and average basket size
- trading hours, from first and last timestamp

No cryptography is needed to extract any of it — it is a `GROUP BY` over public
events. For a market where stalls compete directly, that is commercially
sensitive in a way "volume" undersells.

## The question that decides everything

**What is the ledger FOR?** Three plausible answers, and they do not need the
same data:

1. **Detect a token redeemed twice.** Needs a per-redemption unique tag.
   Needs no amount, and no merchant identity.
2. **Prove conservation — total redeemed never exceeds total issued.** Needs
   amounts to *sum*, but not individually.
3. **Attribute a redemption to a merchant for dispute resolution.** Needs
   identity, but only for the parties to a dispute — not for the public.

The card's own framing points at (1) and (2): *"only the conservation-relevant
facts go public — which is what an audit ledger is for."* If that holds, the
merchant pubkey does not need to be public at all, and the amount does not need
to be readable.

**Worth stating plainly:** double-spend is already prevented. The mint burns
input proofs on swap, and NUT-07 checkstate via
`/api/v1/wallet/token/validate` is the authority (`burn.ts`,
`voucherRecords.ts`). An attestation ledger is for *audit visibility* — proving
after the fact, to someone who was not there, that the books add up. It is not
load-bearing for correctness. That lowers the bar considerably: it may be
lossy, delayed, or incomplete without money going wrong.

## Option A — Nullifier only

Publish one opaque, deterministic tag per redemption. No merchant, no amount,
no voucher id.

```
tag = sha256("imani-redeem:v1" | token_id | proof_secret)
```

A repeat redemption of the same token produces the same tag, so a duplicate is
visible to anyone. Everything else stays private. This is the shape of Monero's
**key image**: detect a double-spend without revealing which output was spent.

**Two details that are easy to get wrong, both verified:**

- **Key on `token_id`, NOT `voucher_id`.** A £10 voucher legitimately comes
  back as £4 then £6 — `redemptionLedger.ts` says as much, *"cashu tokens can
  legitimately share the same voucher_id"* — and splits preserve voucher
  identity byte-for-byte. A voucher-keyed tag therefore **collides on an honest
  partial redemption** and reports a false double-spend. `token_id` is
  `sha256(token)`, content-derived, and already the tombstone key.
- **Bind to a secret.** `voucher_id` and `token_id` are both guessable by
  anyone who has seen the coupon, so a tag derived from those alone can be
  **pre-published by an attacker** to make an honest redemption look like a
  replay. Mixing in the proof secret — which is burnt at the mint and never
  leaves the wallet — makes the tag unforgeable by anyone but the redeemer.

| | |
|---|---|
| Leaks | The count of redemptions system-wide, and their timing. Nothing per-merchant. |
| Answers | "Was this token redeemed twice?" |
| Cannot answer | "How much?", "By whom?" |
| Cost | A hash. No new dependency. |

## Option B — Pedersen commitments for the amounts

Publish `C = amount·G + r·H` instead of the amount. Commitments are additively
homomorphic, so an auditor can verify a **sum** without learning any single
value:

```
sum(C_i) == commit(total, sum(r_i))
```

The merchant reveals the total and the blinding-sum only when they choose to
prove a period. Verified working against the repo's existing `@noble/curves`,
including that a wrong total fails to verify.

Combined with Option A this gives: duplicates detectable by anyone, totals
provable on demand, individual amounts never public.

| | |
|---|---|
| Leaks | Nothing about individual amounts. |
| Answers | "Do the books add up over this period?" |
| Cost | One EC point per redemption (~33 bytes) and a `H` with unknown discrete log. Same library the wallet already uses for voucher signatures. |

## Option C — Rotating per-redemption keys

Sign each attestation with a fresh key rather than the merchant's identity key.
Unlinkable by pubkey. **But it does not stand alone:** amounts stay cleartext
and timestamps still cluster into a trading day, and — fatally — an auditor who
cannot attribute a redemption to a merchant has a ledger that cannot answer
"who redeemed this". Useful only combined with A/B, and mostly redundant with
them.

## Option D — Delayed, batched publication

Publish once per day (or per N redemptions) rather than per redemption. Blunts
timing analysis and hides basket sizes inside a batch, at the cost of
freshness. Cheap, and composes with any of the above. Worth taking regardless
of which option wins, because per-event publication leaks trading hours even
when the payload is opaque.

## Option E — Do nothing public; prove on request

Keep everything sealed and let a merchant produce a signed extract when a
dispute or audit demands one. Zero leak, zero new crypto. The cost is that
nobody can *discover* an inconsistency — only investigate one already
suspected.

Worth listing because it may genuinely be right for now: the mint already
enforces conservation, so this is the option that admits the ledger is a
reporting feature rather than a control.

## Recommendation

**A + D**, and only add **B** if someone actually needs provable totals.

That combination answers the card's stated purpose — conservation-relevant
facts, publicly checkable — while leaking neither identity nor amount, and it
costs a hash and a timer. B is a genuine capability but adds an EC point per
redemption and a trusted-setup-flavoured `H`; it should be paid for by a named
requirement, not adopted speculatively.

**C is not recommended** on its own. **E is the honest fallback** if the answer
to "what is the ledger for?" turns out to be "nothing anyone has asked for
yet" — in which case the right move is to close the card rather than ship
machinery for a hypothetical reader.

## Still to decide (not a technical question)

Who is the intended reader of this ledger, and what are they entitled to know?
Options A/B are only better than the card's proposal if the answer is "anyone
may verify integrity, nobody may see business performance". If a named
regulator or platform operator is entitled to full detail, the cheaper design
is E plus an authenticated extract for that reader — and the public ledger
disappears entirely.
