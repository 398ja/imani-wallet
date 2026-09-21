# Backend change set for `issuance_warrant`

**To:** the issuance path team
**From:** `imani-wallet`
**Re:** the file-level shape of your §8, derived by reading the repos
**Companion to:** `imani-wallet/docs/plan-issuance-warrant.md` (the wallet half)

Your §8 gives the right order. This is what each step touches, plus **one
ordering problem that I think blocks step 3 as written** and which I would
rather raise before anyone starts than after.

Everything below was read, not recalled. Line numbers are from today's HEAD.

---

## 0. The blocker: the merchant is gone before `voucherId` exists

Your §4.2 is correct that the merchant signs, and it is the best finding in
either document. But the digest in §5 is

```
SHA-256(voucher_id ‖ issuer_id ‖ face_value ‖ face_decimals ‖ unit ‖ expires_at ‖ payment_ref)
```

and `voucher_id` does not exist when the merchant is signing.

**The cash path, traced:**

| Where | What happens |
|---|---|
| `POST /api/v1/cash/invoice/{ref}/confirm` | merchant's NIP-98 event verified, `sig` available |
| `CashPaymentSagaService:99` | `@Async` — **the HTTP request returns here** |
| `CashPaymentSagaService:297` | `walletPortAdapter.createVoucher(request)` |
| `VoucherAdapter:510` | `String voucherId = UUID.randomUUID().toString()` |

The `@Async` at line 99 is the problem. The merchant's request has completed
before issuance begins, and the id is minted server-side two hops later. There
is no moment at which the device holds both its key and the `voucher_id`.

So "the device that already signs the NIP-98 confirmation signs one additional
32-byte digest" cannot be done as one extra signature over your §5 digest. The
device cannot compute that digest.

**Four ways out, and I do not know which you prefer:**

1. **Client-supplied `voucher_id`.** The device generates the UUID and sends it
   with the confirmation, so it can sign the digest. Server validates
   uniqueness. Changes `VoucherAdapter:510` from generating to accepting, which
   needs a collision/replay story you currently get free from `randomUUID`.
2. **Drop `voucher_id` from the digest.** Bind to
   `(issuer_id, face_value, face_decimals, unit, payment_ref)`. `payment_ref` is
   the cash invoice `ref`, which the device **does** have at confirmation time,
   and which is already unique per sale. This is my guess at the cheapest fix,
   but it weakens the binding: two identical sales against one `ref` become
   interchangeable, so it rests entirely on `ref` uniqueness.
3. **Two-phase.** Device signs an intent digest pre-issuance; server records it;
   the warrant references the intent rather than the voucher. More moving parts,
   and it is the shape that most resembles what you already do with quotes.
4. **Synchronous issuance on the cash path.** Remove the `@Async` so the id
   exists before the response. Almost certainly wrong — that `@Async` is load
   bearing and the durable-claim logic around it is careful.

**(2) also has the virtue of already being in your digest.** `payment_ref` is
there. The question is whether it is sufficient alone, and that is your call
because you own the `ref` allocation.

I flag this rather than fix it because the answer determines the wire format,
and everything in my wallet-side phase 1 is blocked on the wire format anyway.

---

## 1. Step 1 — retain the NIP-98 event

**`imani-security/.../auth/NostrAuthentication.java`** — a `record` at line 18
with `(pubkey, eventId, method, url, …)`. Add the `sig`, the serialised event,
and **the mechanism**.

The mechanism field is the one your §4.2 correctly insists on. It is a record,
so adding components is source-compatible for readers and breaks every
constructor call. Worth grepping for `new NostrAuthentication(` before sizing
this.

**`imani-security/.../filter/Nip98AuthFilter.java`** — populate the new
components with `mechanism = NIP98`.

**`NapProxyAuthFilter`** — populate with `mechanism = EDGE_SHARED_SECRET` and
no signature. This is the filter that makes the mechanism field necessary
rather than nice.

**Suggestion:** make the mechanism an enum, not a boolean or a string. A third
mechanism will arrive and a boolean will be wrong when it does.

---

## 2. Step 2 — the field, in **two** codecs

Your §5 says "`SignedVoucherCodec` does not pass unknown fields through" and
describes one class. There are **two live copies**, already diverged from each
other:

| Copy | Lines | Notes |
|---|---|---|
| `imani-gateway-core/.../core/voucher/SignedVoucherCodec.java` | 204 | strictest `issuanceRatio`: fiat requires it, throws on non-numeric |
| `imani-gateway-customer/.../customer/voucher/SignedVoucherCodec.java` | 201 | has `serializeLocked`; ratio defaults to `1.0` silently |

Two further copies exist in `imani-bridge`, **a retired repository**
(confirmed; consistent with `imani-deploy/pom.xml:49`, where the bridge
aggregator module is commented out, and with neither gateway pom depending on
`gateway-plugin` or `wallet-plugin`). They are out of scope. Step 2 is two
synchronised edits.

**The retirement leaves a trap in the live pair, and it is worth clearing
before the warrant lands.** Both surviving copies name the retired repo as
their source of truth. Core carries `// NOTE: ported from
imani-bridge/gateway-plugin/gateway-rest — keep in sync with upstream until a
shared Maven module is extracted`; customer claims a "verbatim port … only the
package name was changed". Neither statement is true any more, and the
"upstream" both defer to no longer exists. Anyone adding the warrant who reads
those comments will look for an upstream to sync with, find a retired repo,
and have to guess which live copy leads.

Since the two have already diverged and there is no longer a third to
reconcile against, **there is no upstream: the two are peers.** That is
strictly simpler than what the comments describe, and nothing records it.

**This matters beyond counting.** The divergence is already in exactly the
field class your warrant belongs to: core throws on a non-numeric
`issuanceRatio` and requires it for fiat, customer silently defaults to `1.0`.
A warrant added to one and not the other, or added with different strictness
in each, reproduces that split in the field that carries authorisation. Two
copies is a manageable number and is exactly the number at which people stop
treating divergence as a problem.

**Recommendation, in order:**

1. **Fix the two comments first.** One line each, no behaviour change. They
   currently point maintainers at a retired repo, and they will do so while
   someone is deciding where to put a security-relevant field.
2. **Then either** extract the shared module the core comment already
   anticipates, *before* adding the warrant, **or** accept two synchronised
   edits plus a cross-copy test asserting both round-trip a warranted voucher
   identically.

The extraction is now smaller than when that comment was written: two call
sites and no retired third party to stay compatible with. It is the only
version where "the codec drops the field" cannot happen in one copy and not
the other.

### The stale pointers are not confined to the codec

Having found two, I counted. **36 live Java files** across
`imani-gateway-core`, `imani-gateway-customer` and `cashu-voucher` reference
`imani-bridge`, `gateway-plugin` or `wallet-plugin` — 74 references in all
once poms and docs are included:

| Repo | References |
|---|---|
| `imani-gateway-core` | 29 |
| `cashu-voucher` | 26 |
| `imani-gateway-customer` | 19 |
| `imani-gateway-api` | 1 |
| `imani-security` | 0 |

Most are provenance notes of the "ported from" kind and are harmless in
isolation. The ones that matter are those saying **keep in sync with
upstream**, because they are instructions, and the thing they instruct you to
sync with is gone.

This is not warrant work and I am not proposing it as a blocker. It is
adjacent enough to mention because two of the 36 sit in the exact class this
scheme modifies, and because a codebase whose comments point at a retired repo
will keep costing whoever reads them next. A sweep is cheap and can happen in
parallel with anything here.

### `VoucherCanonicalBytes` needs no change, and that is worth knowing

`cashu-voucher/.../domain/VoucherCanonicalBytes.java:95` loops **all** tags
generically:

```java
for (var tag : secret.getTags()) {
    if (isAddedAfterSigning(tag.getKey())) { continue; }
    appendTag(sb, tag, numericForm);
}
```

So a new tag is covered by the signature automatically. Two conditions:

- `isAddedAfterSigning` (line 145) excludes only `ISSUER_SIG` and
  `ISSUER_PUBKEY`. **Do not add the warrant there.** It must be inside the
  signature: the issuer signing over the merchant's warrant is what stops a
  compromised service stripping it.
- `isNumericTag` (line 150) lists four keys. The warrant is a string, so it
  takes the quoted path and needs no entry. Worth confirming against your
  final shape if any part of it is numeric.

**Tag ordering is insertion order**, so where the warrant tag is added to the
secret determines the signed bytes. Fix it deliberately rather than letting a
builder decide.

---

## 3. Step 3 — emit `merchant` warrants

Blocked on §0 above.

`CashPaymentSagaService:292` already does `.issuerId(entry.merchantPubkey)`
from the authenticated identity, so the binding is correct and only the proof
is missing. `CashSagaEntry` (line 456) is the carrier that would need to hold
the retained event from step 1 through the `@Async` boundary.

Note that crossing `@Async` means the event must be **in the saga entry**, not
in a `SecurityContext` — the context does not propagate to the async thread by
default, and if anything currently reads it there it is reading a cleared one.
Worth checking independently of this work.

**Checked, and it is not configured.** No
`DelegatingSecurityContextAsyncTaskExecutor`, no
`SecurityContextHolder.setStrategyName(MODE_INHERITABLETHREADLOCAL)` anywhere
in `imani-gateway-core` or `imani-security`. So the async thread sees an empty
context, and a warrant derived from `SecurityContextHolder` inside the saga
would read `null` rather than the merchant. That is a fail-closed accident
rather than a vulnerability — but it means the retained event **must** travel
in `CashSagaEntry`, and there is no shortcut available.

---

## 4. Step 4 — `processor` warrants

`VoucherAdapter` builds the pending voucher at line 522 with `issuerId` taken
from the request. The Stripe `charge_id` and `acct_` would need to reach that
point from `payment-adapter`. I have not traced that path and am not going to
guess at it.

One observation from the wallet side: your §7.2 is right that a `processor`
warrant is a claim rather than a proof at verification time. Our reader will
represent it as a **recorded claim** and make it impossible for UI code to
read it as cryptographically verified. If your wire format lets `processor`
and `merchant` be parsed by the same code path into the same shape, that
distinction becomes easy to lose. Consider making the forms structurally
different rather than a discriminated `form` string over one payload.

---

## 5. What I did not check

Stated so you can weigh it.

- **`payment-adapter`.** Not traced at all, so §4 above is thin.
- **`cashu-mint` / `cashu-lib`.** Your §8 says ADR 0006 pins them as a set with
  `cashu-voucher`, so the BOM moves them, but I did not look for warrant-
  relevant code in either.
- **Which of the 36 stale bridge references are instructions rather than
  provenance notes.** I counted them and read two. The rest are unclassified.

Two things that were on this list are now resolved and moved into the body:
`imani-bridge` is retired (so step 2 is two edits, not four), and `@Async`
security-context propagation is **not** configured (so the retained event must
travel in `CashSagaEntry`).

---

## 6. The one thing I would most like an answer to

Not the wire format. **How does the merchant sign a digest containing an id
that does not exist yet?**

If the answer is option 2 (drop `voucher_id`, lean on `payment_ref`), say so
and I will build the wallet reader against that. If it is option 1
(client-supplied id), that is a bigger change than step 3 currently looks, and
it is worth re-ordering §8 to put it first.
