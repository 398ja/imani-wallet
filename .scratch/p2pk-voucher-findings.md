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
