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

## 0. The ordering problem, on the path the wallet actually uses

**Corrected.** An earlier draft of this section traced
`CashPaymentSagaService` and called its `@Async` the blocker. That is the
*imani-apps* cash flow, and `imani-wallet` does not use it. The cash sale here
was deliberately simplified: the merchant presses **Sell**, a coupon is issued,
and it is sent to the recipient. No cash invoice, no confirmation webhook, no
saga. The `@Async` finding is real but it is about a path this wallet does not
take, so it is not the blocker and §3 below is rewritten accordingly.

**What the Sell button actually does:**

| Where | What |
|---|---|
| `imani-wallet/src/lib/issue.ts:311` | `signedFetch('/api/v1/portal/vouchers', 'POST')` — NIP-98 signed by the merchant's device |
| `PortalVoucherController:220` | `createVouchers`, **no `@Async`** |
| `PortalVoucherController:354` | `.issuerId(issuingStall(pubkey))` — the stall from the authenticated identity, never a request field |
| `CustomerWalletPortAdapter:110` | forwards to customer-wallet |
| `VoucherAdapter:510` | `UUID.randomUUID()` |

**The good news, and it is substantial.** This path is **synchronous end to
end**. The merchant's NIP-98 request is still open when the voucher is minted,
so the retained event from step 1 reaches issuance through the ordinary call
stack. No saga entry, no `@Async` boundary, no context-propagation problem.
The portal already refuses to take the issuer from a request field, so the
binding `warrant → issuerId` is enforced one layer above the codec.

That makes the `merchant` warrant much cheaper here than their §4.2
anticipated, because §4.2 was written against the cash-invoice flow.

**The residual problem is narrower, and it survives.** `voucher_id` is still
minted at `VoucherAdapter:510`, two hops downstream of the device, and the
digest covers it:

Your §4.2 is correct that the merchant signs, and it is the best finding in
either document. But the digest in §5 is

```
SHA-256(voucher_id ‖ issuer_id ‖ face_value ‖ face_decimals ‖ unit ‖ expires_at ‖ payment_ref)
```

The device signs before the id exists. It is not a concurrency problem now,
just an allocation-order one, and being synchronous makes the options better:

1. **Client-supplied `voucher_id`.** The device generates a UUID, signs the
   digest, sends both. `VoucherAdapter:510` accepts instead of generating.
   Cheap on a synchronous path and the natural fit here, but it needs a
   uniqueness and replay story that `randomUUID` currently gives for free.
2. **Drop `voucher_id` from the digest.** Bind to
   `(issuer_id, face_value, face_decimals, unit, expires_at)`. Note there is
   **no `payment_ref` on this path** — the earlier draft leaned on the cash
   invoice `ref`, and the simplified Sell flow does not have one. Without it,
   two identical sales by the same stall on the same day produce identical
   digests, so one warrant replays onto the other. That is weak enough here to
   be worth saying plainly, and it is the option I would now argue against.
3. **Server returns the id, device signs second.** Two round trips: mint the
   id, return it unsigned-warrant, device signs, second call attaches. Only
   viable because the path is synchronous and the merchant is present. Doubles
   the calls on the hot Sell path.
4. **Server-chosen id, derived deterministically** from fields the device
   already signs, so both sides compute the same id independently. Removes the
   ordering problem entirely, and constrains id allocation in a way you may not
   want.

**I am not going to recommend one, and §3 is why.** A first pass here argued
for (1) on the grounds that the path is synchronous and the merchant is
present. Then reading `createVouchersParallel` showed that **one Sell action
can mint many vouchers**: a `quantity`, and each of those auto-splitting again
server-side when a voucher would be too large to receive. The device cannot
know how many ids there will be, so "the device generates the id up front"
does not straightforwardly work either.

What survives is that (2) is weaker here than it looked — there is no
`payment_ref` on this path to lean on — and that every option needs an answer
to the auto-split. That answer is a design decision about **what a warrant
attests**: the specific voucher, or the sale that produced it. See §3.

I flag rather than fix because the answer determines the wire format, and my
wallet-side phase 1 is blocked on the wire format anyway.

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

### The portal path, which is the one that matters for this wallet

`PortalVoucherController:354` already does `.issuerId(issuingStall(pubkey))`,
taking the stall from the authenticated identity and never from a request
field. The class comment in `issue.ts` records why: voucher creation is refused
outright on the customer tier, so issuance routes to the portal precisely
*because* the portal derives the issuer from whoever it authenticated.

**So the binding is already correct and only the proof is missing** — exactly
the shape their §4.2 found on the cash path, arriving here by a different
route. The work is:

1. Carry the retained NIP-98 event from step 1 down through
   `createVoucherOfValue` into `CreateVoucherRequest`.
2. Have the customer tier write it into the warrant tag before signing.

No saga, no async boundary, no new carrier type. It is parameter passing on a
synchronous call stack.

**One caveat on `createVouchersParallel`.** `PortalVoucherController:473` fans
a multi-voucher request across `Executors.newVirtualThreadPerTaskExecutor()`,
so those vouchers are minted off the request thread and a
`SecurityContextHolder` read inside the lambda would see an empty context.

**The existing code already does the right thing** and is worth copying rather
than working around: `pubkey` is threaded through as a **parameter**, from
`createVouchersParallel` into `createWithAutoSplit` into
`createVoucherOfValue`. The retained event should follow exactly that path.
No context propagation needed, because the code never relied on context here.

**Quantities multiply, twice.** A request has a `quantity`, and *each* of those
then auto-splits when a single voucher would be too large to receive
(`createWithAutoSplit`, which is why the method returns a `List` per future).
So one Sell action can mint many vouchers, each with its **own** `voucher_id`
and face value, and each needs **its own warrant**. Whichever option from §0
is chosen must work *n* times per request, where *n* is not known until the
split runs.

That is an argument against §0 option 3 (device signs after the server returns
the id): the device would have to sign an unknown number of digests in a second
round trip. It is also the strongest argument for option 1, where the device
can generate and sign ids up front only if it knows the count — which it does
**not**, because auto-split is a server-side decision based on token size.

**This is worth your attention before picking.** The auto-split means even
option 1 needs a story for ids the device did not anticipate. The cleanest
version may be that the device signs one warrant over the *requested* amount
and the server records the split as derived from it, but that changes what a
warrant attests, so it is your call and not mine.

### The cash saga, for completeness

`CashPaymentSagaService:292` does `.issuerId(entry.merchantPubkey)` and is the
path `imani-apps` uses. If it is still live for other clients it needs the
same treatment, with one extra constraint: **`@Async` security-context
propagation is not configured** — no `DelegatingSecurityContextAsyncTaskExecutor`
and no inheritable-threadlocal strategy anywhere in `imani-gateway-core` or
`imani-security`. The async thread sees an empty context, so a warrant derived
from `SecurityContextHolder` inside the saga would read `null`. Fail-closed
rather than dangerous, but it means the event must travel in `CashSagaEntry`
and there is no shortcut.

Not this wallet's problem. Recorded because it was found and is easy to lose.

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

Not the wire format. **Does a warrant attest a voucher, or a sale?**

Your §5 digest covers `voucher_id`, which makes it a statement about one
voucher. But on this wallet's path one Sell action mints an unknown number of
vouchers — a `quantity`, each auto-splitting server-side by token size — and
none of their ids exist when the merchant signs. A per-voucher warrant
therefore cannot be produced by the device, under any of the four options in
§0, without a second round trip over a count it cannot predict.

A per-**sale** warrant does not have that problem: the device signs the total
it is selling, once, and the server records each minted voucher as derived
from that warrant. It costs something real — a verifier can then check that a
sale was authorised, but must trust the server's split arithmetic to relate a
specific coupon to it, and that arithmetic is inside the trust boundary the
scheme exists to get outside of.

I do not think that is fatal, because the **amount** is still bound and the
amount is what your §3 correctly identified as the thing that matters. But it
is a real weakening and it should be a decision rather than a discovery.

Whichever way it goes, say so explicitly and I will build the wallet reader
against it. If it is per-sale, the wallet also needs to know how a coupon
references its parent warrant, because that reference is what my reader
verifies.
