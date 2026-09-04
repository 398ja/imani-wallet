# Embedding a P2PK voucher in the API: what is actually in the way

Investigated 2026-09-04 against the running `imani-test` stack. Conclusion
first: **it is not supported, and the blocker is not where it looks.**

## What I verified, layer by layer

| Layer | State | How I know |
| --- | --- | --- |
| `cashu-lib` | `P2PKVoucherSecret` EXISTS (0.29.0) | read the class; `javap` on the installed jar |
| `cashu-mint` 0.35.0 | ENFORCES it. `P2PKVoucherSpendingCondition` runs the voucher checks AND the NUT-11 witness | read the validator; `/v1/info` reports NUT-10/11/12 supported |
| `imani-gateway-customer` | NEVER references the kind | grep across both gateways returns nothing |
| Real minted tokens | kind `VOUCHER`, `tags: []` | decoded my live licence and terminal-credential fixtures |

So both ends are ready and the middle does not connect them. That much
matches the comment already in `packages/licence/src/types.ts`.

## The real blocker is deeper than a missing branch

I started implementing it in `VoucherAdapter` and stopped when the types said
something more interesting. Three obstacles, in increasing order of severity:

**1. Version pin (FIXED).** The gateway resolved cashu-lib 0.28.0, where the
class does not exist. Bumped to imani-bom 0.1.62; 366 tests pass.

**2. `SignedVoucher` is hard-typed to `VoucherSecret`.** `P2PKVoucherSecret`
is its SIBLING — both extend `WellKnownSecret` — deliberately, so the mint can
test for it first and not let a broader "is a voucher" branch swallow it. But
`VoucherSignatureService.createSigned` and both `SignedVoucher` constructors
take `VoucherSecret`, so a locked secret cannot flow through them. Note
`sign()` itself already takes `WellKnownSecret`; only the wrappers are narrow.

**3. The gateway does not emit a NUT-10 secret at all.** This is the one that
matters. `SignedVoucherCodec.serialize` builds a bespoke CBOR map
(`voucherId`, `issuerId`, `faceValue`, …) and that blob is stuffed whole into
`data`. Decoding a real token confirms it:

```
kind      : VOUCHER
2nd elem  : { nonce, data, tags }
data head : bf69766f75636865724964782436623439333933   (CBOR map)
tags      : []
```

A genuine `P2PK_VOUCHER` needs the inverse shape: the spending key in `data`,
and the voucher fields as TAGS, because that is what the mint's condition
reads and what `VoucherCanonicalBytes` signs over. The current wire format has
no room for a lock — there is nowhere for the key to go.

## What implementing it actually requires

Not a branch in `VoucherAdapter`. In order:

1. Widen `createSigned` and `SignedVoucher` to `WellKnownSecret`
   (cashu-voucher). Low risk: the signing internals are already generic.
2. Change `SignedVoucherCodec` to emit a real NUT-10 secret — fields as tags,
   not a CBOR blob in `data`. **This is a wire-format change**, so old tokens
   and new ones must both parse for the lifetime of every voucher already
   issued.
3. Then the `VoucherAdapter` branch, which is the easy part: read `lock_key`
   from `merchant_metadata` (where both credential types already put it) and
   build a `P2PKVoucherSecret` instead.
4. Wallet-side: teach `voucherToken.ts` to read the composite form.

Step 2 is the real work and deserves its own ADR, because it changes bytes
that customers already hold.

## Meanwhile

The locks in the wallet today are **signed metadata enforced by the client**,
not by the mint. `credentialActor` refuses a credential whose `lock_key` is
not this device's key, and the issuer's signature means the value cannot be
forged or altered. A modified client could ignore it; the mint would not stop
them. Terminals ADR 0005 and the licence types comment both already say so —
this is a known limitation, not a regression.

---

# Update 2026-09-04: implemented, not yet proven end to end

## Landed

| Step | Repo | State |
| --- | --- | --- |
| BOM 0.1.59 -> 0.1.62 | imani-gateway-customer | done, 366 tests |
| Four missing accessors on `P2PKVoucherSecret` | cashu-lib | done, 974 tests |
| `SignedLockedVoucher` | cashu-voucher | done, 148 tests |
| Legacy wire format pinned | imani-gateway-customer | done, 4 tests |
| `VoucherAdapter` issues locked when `lock_key` is usable | imani-gateway-customer | done, 381 tests |

Unlocked issuance is byte-for-byte unchanged, which the legacy characterisation
test proves against a token a real gateway issued.

## What is NOT yet proven

**That the mint refuses a witness-less spend of a locked voucher.** This is the
only claim that ultimately matters, and it needs a locked voucher minted end to
end.

I could not get one on the test stack. Rebuilding gateway-customer against the
0.1.62 BOM produced a container whose `wallet-core` client fails on
`mintQuotePaid` with "Mint client execution failed", while the SAME endpoint
returns `"state":"PAID"` over plain HTTP from inside that container.

So the version set is not as aligned as `imani-bom` implies: cashu-lib 0.29.0
and cashu-mint 0.35.0 agree, but the wallet-core the BOM pairs with them does
not parse this mint's quote response. That is worth chasing before anyone
deploys 0.1.62, and it is upstream of the P2PK work rather than caused by it.

Until then the adapter change is unexercised against a live mint. It is covered
by unit tests and mutation controls, and it cannot affect unlocked issuance —
but "the mint enforces the lock" remains a claim, not an observation.

## Note for whoever picks this up

While investigating I ran `git stash` in imani-gateway-customer and collided
with a colleague's in-flight `015-stale-source-token-defenses` work. Their
files are restored byte-identical to their stash, which is intact at
`stash@{0}`. Their tree does not compile on its own — it references classes
their own stash adds — and that is unrelated to this work: a clean tree at HEAD
compiles with zero errors.
