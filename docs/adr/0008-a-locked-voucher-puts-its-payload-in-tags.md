# 8. A locked voucher puts its payload in tags, not in `data`

Date: 2026-09-04

## Status

Proposed. Blocks mint-enforced locks on licences and terminal credentials.

## Context

Licences (ADR 0007) and terminal credentials (ADR 0005) are both *locked*: a
credential is meant to be useless to anyone but the holder of one specific
key. Today that lock is a `lock_key` field inside the issuer-signed
`merchant_metadata`, and it is enforced **by the client**.

That is weaker than it reads. The value cannot be forged or altered, because
the issuer's signature covers it. But nothing stops a modified client from
ignoring it, and the mint will happily let the proof be spent by whoever
presents it. Every check we wrote is the only thing in the way.

Cashu has the right primitive, and our stack already ships it:

- `cashu-lib` 0.29.0 defines `P2PKVoucherSecret`, a composite NUT-10 kind that
  is a voucher **and** a NUT-11 lock.
- `cashu-mint` 0.35.0 enforces it. `P2PKVoucherSpendingCondition` runs the
  voucher checks *and* the witness check; running only one is the failure the
  kind exists to prevent.
- `imani-bom` 0.1.62 pins the two together with `cashu-voucher` 0.13.0.

So both ends are ready. The gateway is what does not connect them, and the
reason is more specific than "nobody wrote the branch".

### The blocking conflict

`P2PK_VOUCHER` requires the spending key in `data`, because that is where
NUT-11 looks. The voucher fields therefore live in **tags** — which is exactly
how `P2PKVoucherSecret` models them, and what `VoucherCanonicalBytes` already
signs over for both kinds.

Our wire format does the opposite. `SignedVoucherCodec.serialize` builds a
bespoke CBOR map of the voucher fields, and `VoucherWellKnownSecret` puts that
whole blob into `data` via `setData`. Decoding a real token issued by the
running stack:

```
kind      : VOUCHER
2nd elem  : { nonce, data, tags }
data head : bf69766f75636865724964782436623439333933   (a CBOR map)
tags      : []
```

`data` is occupied and `tags` is empty — the precise inverse of what a lock
needs. **There is nowhere to put the key.** This is a wire-format conflict,
not a missing conditional, which is why the change deserves a decision record
rather than a commit message.

The conflict is structural rather than a matter of convention.
`P2PKSecret.validate()` does:

```java
P2PKPublicKeys.requireValid(getData(), "data");
```

So `data` must BE a public key. A CBOR blob there is not merely unconventional,
it is rejected — and `P2PKVoucherSecret` inherits that validation unchanged,
which is the whole reason it extends `P2PKSecret`. Verified against
cashu-lib 0.29.0 as shipped, not inferred from the docs.

## Decision

Move the voucher payload from `data` into tags, and use the kind to carry the
lock.

An unlocked voucher stays `VOUCHER` and gains tags. A locked one becomes
`P2PK_VOUCHER`, with the spending key in `data` and the same tags. The two
forms then differ only where they must.

### Why not the alternatives

**Keep the blob and add a lock tag.** The mint dispatches on kind. A `VOUCHER`
carrying a `lock` tag goes to the voucher condition, which never checks a
witness — so the lock stays advisory and we would have shipped something that
*looks* enforced. This is the exact trap `P2PKVoucherSecret`'s own javadoc
warns about.

**Use a plain `P2PKSecret` and put voucher fields in tags.** The lock would be
enforced, but the issuer signature commits to the kind and to `data`. Signing
as `P2PK` would leave the signature covering a document that never exists on
the wire, and demote the voucher id to a tag while `data` became the key.

**A parallel `lock_key` request field.** Rejected on different grounds: the
lock is already inside the signed metadata. A second copy could disagree with
the first, and a voucher whose signed metadata names one holder while the mint
enforces another is worse than either alone. The gateway should read the lock
from where it already is.

## Consequences

### This changes bytes customers already hold

Every voucher issued to date has the blob-in-`data` shape, and those tokens
outlive the change — a licence runs a year, a coupon up to ninety days. So:

- **Readers must accept both forms** for at least the longest voucher
  lifetime. `voucherToken.ts` already tolerates two NUT-10 serialisations for
  a related reason, and this is a third case of the same discipline.
- **Writers switch once.** No dual-write: two live formats from one issuer
  doubles the matrix for no benefit, since old tokens are already written.
- **Canonical bytes are unaffected in form but not in value.** They are built
  from kind, `data`, nonce and tags. Moving fields from `data` into tags
  changes the input, so a re-serialised old voucher would not verify against
  its stored signature. Old tokens must be verified in their original form,
  which is the strongest argument for keeping the old reader rather than
  migrating tokens in place.

### Enforcement moves to the mint

The intended win. After this, a revoked or stolen credential is refused by the
mint rather than by our client, and `credentialActor`'s lock check becomes
defence in depth instead of the only defence.

### Ordering

1. Widen `VoucherSignatureService.createSigned` and `SignedVoucher` to
   `WellKnownSecret`. Low risk: `sign()` and `VoucherCanonicalBytes` are
   already generic over it, and the upstream `P2PKVoucherSignatureTest` signs
   a locked voucher through `sign()` today.
2. Change `SignedVoucherCodec` to emit tags, and to read both forms.
3. Add the lock to the swap path. `SwapWithCustomSecretRequest` grows an
   optional `lockPubkeyHex`; when present the outputs are built as
   `P2PKVoucherSecret`.
4. `VoucherAdapter` reads `lock_key` from `merchant_metadata` and passes it
   through. This is the small part.
5. Wallet: teach `voucherToken.ts` the tag form, keeping the blob reader.

Steps 1-3 are upstream of this repo. Step 4 is where the behaviour becomes
visible, and it must not land before 2, or every locked voucher issued in
between is unreadable.

### Until it lands

The client-side lock stays, and stays honest about what it is: signed
metadata that a modified client could ignore. Both ADR 0005 and the comment
in `packages/licence/src/types.ts` already say so.
