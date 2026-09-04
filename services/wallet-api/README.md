# The wallet API

A REST API for programs that spend a customer's coupons: a script that pays a
supplier every Friday, a service that tops up a float, a bookkeeping tool that
reads a holding. Everything the wallet app decides about money, without the app.

Running: `npx tsx services/wallet-api/server.ts` (port 8788), or the container
built from `services/wallet-api/Dockerfile`.

## The one thing to understand first

**The service holds neither your key nor your coupons.** You send your coupons
with each request and receive the resulting state back. Nothing is stored between
requests: no account, no database, no session.

That is a deliberate trade, recorded in [ADR 0001](../docs/adr/0001-caller-holds-the-key.md).
Coupons are bearer instruments, so a service holding them holds custody of value
whoever holds the key. A breach of a custodial API is a theft; a breach of this
one is a denial of service.

**The cost lands on you: if you lose a response, you lose the coupons it
described.** Persist transactionally around every call that changes state. This
is said here rather than left to be discovered.

Reads like `/v1/holding/value` do not change anything, so a lost response there
costs you a retry and nothing else.

### The service cannot spend, and that is enforced

Not a promise in prose: **there is no code path here capable of signing or
spending**, which is what makes a public spending endpoint defensible at all
([ADR 0002](../docs/adr/0002-the-api-plans-the-caller-signs.md)). Where a
signature is needed, you sign and the service forwards yours verbatim — it is a
courier for a signature it cannot forge.

Two checks hold that true rather than trusting it:

- `__tests__/cannotSpend.test.ts` fails if any source file invokes an operation
  that signs or spends, and names the file and the call.
- The image build fails if signing capability is reachable in the shipped tree
  at all, across every executable extension. That guard has caught two real
  escapes: `sign.mjs` walking into the image past a `*.ts`-only scan, and the
  sealing path that arrived with `/v1/spend/parts/prepare`.

The service does verify signatures, and must: `schnorr.verify` is how it
authenticates you. The boundary is the operation, not the import — `.verify` is
its job, `.sign` would be the end of the argument above.

## Authenticating

Every request except `/health` and `/metrics` carries a
[NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) signature: a
kind 27235 event, base64-encoded, in the `Authorization` header under the `Nostr`
scheme.

```
Authorization: Nostr <base64(signed event)>
```

The event's tags bind the signature to the exact request:

| tag | must be |
|---|---|
| `u` | the absolute URL, including the query string |
| `method` | the HTTP method |
| `payload` | sha256 of the exact request body, when there is one |

Your identity **is** the public key that signed. There is no account to create
and no token to issue, so there is nothing to steal and nothing to revoke.

Sign the body you actually send, byte for byte. Serialise once and hash that
string: re-serialising with a different key order produces a different hash and
the request is refused.

### When a request is refused

A 401 names one reason, because each has a different fix:

| `error` | what to do |
|---|---|
| `unsigned` | send an `Authorization` header |
| `malformed` | the credential is not a base64 kind-27235 event |
| `bad-signature` | the event was altered, or not signed by the key it claims |
| `stale` | check the clock on the calling machine; the window is 60s each way |
| `url-mismatch` | you signed a different URL, or a different query string |
| `method-mismatch` | you signed a different method |
| `payload-mismatch` | the body does not match what you signed |

`stale` is the one people misdiagnose. It means a clock, not a key.

## Endpoints

### `GET /health`

Unauthenticated, because an orchestrator has no key. Returns `{"status":"ok"}`.

### `GET /v1/whoami`

Returns the public key that signed the request.

```json
{ "pubkey": "0bc0ace1…" }
```

Hit this first when your signing is not working: it separates a bad key from a
bad request in one call.

### `POST /v1/holding/value`

What a holding is worth, grouped by stall and currency.

POST rather than GET because the holding **is** the request. Coupons in a URL
would land in access logs and proxy caches, and a logged bearer coupon is a
spendable one.

```json
{
  "coupons": [
    {
      "voucher_id": "c1",
      "token": "cashuB…",
      "face_value": 1000,
      "face_unit": "EUR",
      "face_decimals": 2,
      "token_amount": 500,
      "issuer_id": "aaaa…",
      "status": "active"
    }
  ]
}
```

`token` and `face_value` are required. Everything else is optional, and any field
the service does not read is ignored rather than rejected: the state is yours.

```json
{
  "groups": [
    {
      "stallId": "aaaa…",
      "currency": "EUR",
      "decimals": 2,
      "faceValue": 1000,
      "tokenAmount": 500,
      "couponCount": 1
    }
  ],
  "unusable": [{ "couponId": "c4", "reason": "spent" }],
  "couponCount": 2
}
```

**There is no total, and that is not an omission.** A coupon is a claim on
exactly one stall, honoured by that stall alone. Five from one stall and five
from another is not ten of anything — no transaction either number could pay
for. The same holds across currencies within one stall. Group before you decide
whether a spend is possible.

`faceValue` is in the currency's **minor units** (cents, not euros), because that
is what a coupon carries. Rendering is your decision, so `decimals` comes with
it.

**Every coupon you send comes back accounted for**, either inside a group or in
`unusable` with a reason:

| `reason` | meaning |
|---|---|
| `spent` | spent, or redeemed and burnt at the issuing stall |
| `expired` | past its expiry |
| `no-value` | face value of zero |
| `no-token` | no cashu token, so no proofs to present |

`groups` plus `unusable` always sum to `couponCount`. Unusable coupons are
reported rather than dropped because a reconciler needs to know the difference
between money you have and money you had — a program told about 98 of the 100
coupons it sent would most likely conclude its request was mangled.

An empty holding is a valid request with an empty answer, not an error.

Groups are ordered largest first, with ties broken by stall and currency, so the
same holding always serialises identically and a diff between two reads shows
only real changes.

### `POST /v1/spend/plan`

Which of your coupons would be spent for an amount, or why none can be. **Nothing
moves.** This is the question asked before the money is touched, so an impossible
spend fails while the holding is still whole.

```json
{
  "coupons": [ … ],
  "stallId": "aaaa…",
  "currency": "EUR",
  "amount": 400
}
```

`amount` is in **minor units** and must be a whole number. A fractional amount is
refused rather than rounded: it means cents were wanted and euros were sent, and
silently flooring it would plan the wrong spend.

```json
{
  "parts": [{ "couponId": "c1", "amount": 400, "faceValue": 1000, "whole": false }],
  "obstacle": null,
  "available": 1000,
  "eligibleCount": 1
}
```

Only coupons from that stall, in that currency, unspent and unexpired take part.
A coupon from another stall is never drawn in, however conveniently sized: a
stall cannot honour what it did not issue, and a coupon sent to one that cannot
honour it is money that simply stops.

### Where a coupon may be sent

Pass `recipientPubkey` and the plan also checks whether that recipient could
honour these coupons. Optional: a caller asking only "can I afford this?" has no
recipient yet, and requiring one would make the cheap question need a network
round trip.

A refused send comes back as a `refusal`, again with **200** and with no parts:

```json
{
  "parts": [],
  "obstacle": null,
  "refusal": {
    "reason": "wrong-stall",
    "detail": "These coupons were issued by aaaa…, and the recipient is a different stall…"
  }
}
```

| `reason` | meaning |
|---|---|
| `wrong-stall` | the recipient is a stall, but not the one that issued these coupons |
| `recipient-unknown` | the recipient's role could not be checked |
| `self-send` | you are sending to your own key |

**A coupon is a claim on exactly one stall.** Sent to a different stall it is
something they cannot honour, cannot redeem and cannot return, and the money
simply stops — nothing downstream catches it.

Sending a stall **its own** coupons is a redemption and is always allowed, with
**no network lookup at all**. It is the common case and the one a market stall
depends on, so it keeps working when the relay does not.

`recipient-unknown` **refuses**, and this is deliberate rather than
conservative. A send blocked by an outage is retried a minute later; a coupon
that lands on a stall which cannot honour it is money the customer no longer
holds and the merchant cannot give back. Only the second is unrecoverable. The
detail says the check could not be made and that nothing has moved.

Because redemption needs no lookup, failing closed costs only cross-stall sends,
which are rare. That is what makes the strictness affordable.

### When a spend cannot be planned

The answer is still **200** with an `obstacle`. The question was answered
successfully; the answer being "no" is a normal result, not a failed request.

```json
{
  "parts": [],
  "obstacle": {
    "kind": "not-splittable",
    "detail": "The smallest amount this voucher can be split into is 200.",
    "available": 1000,
    "requested": 150,
    "minimumStep": 200
  },
  "available": 1000,
  "eligibleCount": 1
}
```

Two kinds, and the difference is what you should do about it:

| `kind` | meaning | what helps |
|---|---|---|
| `insufficient-value` | the eligible coupons do not add up | more coupons from that stall in that currency |
| `not-splittable` | they add up, but no combination divides to exactly this amount | a different amount — more coupons of the same shape will not help |

`not-splittable` is the one worth handling properly. A coupon divides only in
steps of `minimumStep`, so some amounts are unreachable from a holding that is
nominally more than sufficient. A caller that treats every failure as "try again
later" will retry forever.

This plan is the same plan the wallet app would make from the same holding — the
decisions come from one shared package, and a parity test runs both over the same
holdings to prove it.

### Malformed requests

A 400 names the field at fault:

```json
{
  "error": "invalid-request",
  "field": "coupons[3].face_value",
  "detail": "expected a finite number, got a string (\"1000\")"
}
```

Only the **first** error is reported. A systematic mistake across a 500-coupon
holding would otherwise answer with the same sentence 500 times.

## Retrying safely

The service refuses a signature it has already seen. That is replay protection:
a captured request resent verbatim must not be honoured twice, and shortly this
service will be able to move money.

A refused replay is **409**, not 401. Your signature was valid; it had simply
been used.

```json
{ "error": "replay", "detail": "this exact signed request has already been seen…" }
```

**To retry safely, sign a fresh request and reuse your `Idempotency-Key`.**

```
Idempotency-Key: pay-supplier-2026-01-14
```

A repeat of the same key from the same caller returns the **original response**,
without doing the work again, marked so you can tell:

```
Idempotency-Replayed: true
```

Keys are scoped to your public key, so your `retry-1` and another caller's
`retry-1` are unrelated. Answers are kept for 24 hours. Only successful
responses are stored — replaying a 400 would keep telling you a request is
malformed after you had fixed it.

Nothing forces you to send a key. Without one, an honest retry is simply a new
request.

### Why a fresh signature

NIP-98's `created_at` is in seconds, so a naive signer produces byte-identical
events for two requests in the same second, and the second is indistinguishable
from a replay. Both signers in this repository add a `nonce` tag for that
reason. If you are writing your own, add one.

### Being throttled

Requests are limited **per public key**, not per address, so sharing a NAT or a
cloud egress range with another caller does not throttle you.

Over the limit is **429**, with the delay in both the header and the body:

```
Retry-After: 34
```

```json
{ "error": "rate-limited", "detail": "…Retry in 34s.", "retryAfterSeconds": 34 }
```

Back off by that long. It is never zero.

### Under extreme load

If the service cannot guarantee replay protection it refuses with **503** and
`error: at-capacity` rather than proceeding unprotected. This is deliberate: a
caller retrying in a minute is better than a spend that happens twice, and
[ADR 0001](../docs/adr/0001-caller-holds-the-key.md) already accepts denial of
service as this design's failure mode.

Replay state is held **per process**. Staging runs a single replica, which is
what makes that adequate; scaling out needs a shared store and a decision
record.

### `POST /v1/spend/parts/prepare`

Prepare one part of a plan: the coupons that replace the one being spent, and an
**unsigned** event for you to sign and publish. This is where a script spends.

**One part at a time.** Parts fail independently, so one failing strands nothing
else, and you own the retry loop — which is correct, because you own the coupons.

#### Two signatures, not one

The split runs on the gateway, behind NIP-98, and **this service holds no
credential of its own to present there**. If it did, that credential would be a
way to split any coupon anyone sent it, which is the custody
[ADR 0001](../docs/adr/0001-caller-holds-the-key.md) refuses. So you sign the
gateway request too, and the service forwards your header verbatim. It is a
courier for a signature it cannot forge.

Ask what to sign rather than deriving it:

```
POST /v1/spend/parts/gateway-request
{ "token": "cashuB…", "amount": 200 }
```

```json
{
  "url": "http://gateway-core:8081/api/v1/atomic/vouchers/split",
  "method": "POST",
  "body": "{\"token\":\"cashuB…\",\"send_face_value\":200}"
}
```

Sign that `body` string **byte for byte**. Re-serialising it changes the payload
hash and the gateway refuses the request as a mismatch — from a service you never
addressed directly, which is a confusing afternoon.

The memo is deliberately not part of the signed body. It belongs to the message,
not to the division of a coupon, and it travels in the event instead.

#### Preparing

```
POST /v1/spend/parts/prepare
Idempotency-Key: pay-supplier-2026-01-14-part-0
```

```json
{
  "token": "cashuB…",
  "amount": 200,
  "recipientPubkey": "c1c1…",
  "stallId": "aaaa…",
  "currency": "EUR",
  "decimals": 2,
  "couponId": "c1",
  "memo": "invoice 4471",
  "gatewayAuthorization": "Nostr <base64 of the event you just signed>"
}
```

```json
{
  "prepared": {
    "replaces": "c1",
    "sent": { "token": "cashuB…", "faceValue": 200, "faceUnit": "EUR", "faceDecimals": 2, "couponId": "sent-1", "stallId": "aaaa…" },
    "change": { "token": "cashuB…", "faceValue": 800, "faceUnit": "EUR", "faceDecimals": 2, "stallId": "aaaa…" },
    "unsignedEvent": {
      "kind": 14,
      "content": "{\"type\":\"cashu_token_transfer\",…}",
      "tags": [["p", "c1c1…"]]
    },
    "recipientPubkey": "c1c1…"
  },
  "refusal": null,
  "holdingUnchanged": false
}
```

**`replaces`, `sent` and `change` are one write.** The coupon named by
`replaces` no longer exists; those two are what exists instead. Commit them
transactionally before doing anything else — including before signing.

`change` is `null` for a full send, rather than a zero-valued coupon that could
never be spent and would sit in your holding forever.

#### Signing and publishing

The event has no `id`, no `pubkey` and no `sig`. You supply all three by sealing
and wrapping it with your own key, which is the step this service cannot perform:
sealing derives a conversation key from the customer's private key, and this
service has never had one. [ADR 0002](../docs/adr/0002-the-api-plans-the-caller-signs.md)
records why, and the image build fails if anything able to sign or seal is
reachable in the shipped tree.

```js
import { nip17 } from 'nostr-tools'

const wrap = nip17.wrapEvent(mySecretKey, { publicKey: recipientPubkey }, prepared.unsignedEvent.content)
await Promise.any(pool.publish([relayUrl], wrap))
```

The outer wrap is signed by a throwaway key, per NIP-59; the inner rumor carries
your real identity, which is how the recipient knows who paid. The
`sender_pubkey` in the payload is taken from **your signature on this request**,
never from the request body, so you cannot address a send as somebody else.

#### When the gateway fails

Every failure answers with `holdingUnchanged: true`, and it means exactly what it
says: nothing was split and your coupon is still whole and still yours.

| status | `error` | what happened |
|---|---|---|
| 502 | `gateway-unreachable` | it could not be reached, or timed out |
| 401 | `gateway-…` | **your** signature was refused; fix the payload hash or the clock |
| 409-mapped 502 | `gateway-swap_rejected` | the mint refused the swap, usually because the proofs are already spent |
| 502 | `gateway-incomplete` | it claimed success but returned no send token |

`gateway-incomplete` is the one to treat carefully: re-read your holding before
retrying, because the coupon may already have been split.

**Failures are not stored against your idempotency key.** Only successful
responses are, so a retry after an outage really does retry.

#### Retrying safely

Reuse the `Idempotency-Key` and sign a fresh request. The original answer comes
back, marked `Idempotency-Replayed: true`, and **the gateway is not called
again** — a second call would be a second split, which divides a coupon twice and
strands half of it.

#### Where a coupon may be sent

The same check as `/v1/spend/plan`, and it runs **before** the split — the only
ordering that leaves the coupon whole. A refusal is 200 with `prepared: null`:

```json
{ "prepared": null, "refusal": { "reason": "wrong-stall", "detail": "…" }, "holdingUnchanged": true }
```

### `GET /metrics`

Unauthenticated counters: requests, errors, refusals by reason, validation
errors, guard statistics, parts prepared, prepare failures by reason, and live
store sizes so boundedness is observable.

`prepareFailures` is worth an alert. `gateway-unreachable` climbing is an outage;
`gateway-swap_rejected` climbing is callers spending coupons that are already
spent, which is a bug somewhere else entirely.

## Using it with curl

Reads work with ordinary HTTP tooling, but every request still needs a
signature, and curl cannot sign. `sign.mjs` prints an `Authorization` header and
nothing else, so it composes:

```bash
URL=http://localhost:8788/v1/holding/value

curl -sX POST "$URL" \
  -H "Authorization: $(node services/wallet-api/sign.mjs new POST $URL holding.json)" \
  -H 'content-type: application/json' \
  --data-binary @holding.json
```

`new` mints a throwaway identity and prints its npub to stderr, which is enough
to explore the API. Pass an `nsec` or a hex secret to sign as yourself.

A read needs no body file:

```bash
W=http://localhost:8788/v1/whoami
curl -s "$W" -H "Authorization: $(node services/wallet-api/sign.mjs new GET $W)"
```

**Use `--data-binary`, not `-d`.** `-d` strips newlines, which changes the bytes
and therefore the payload hash, and the request is refused as
`payload-mismatch` — verified, not assumed. Same file, same header, different
flag, different answer.

## The whole spend, end to end

```
POST /v1/spend/plan              which coupons, or why none
  for each part:
    POST /v1/spend/parts/gateway-request    what to sign for the gateway
    sign it locally
    POST /v1/spend/parts/prepare            replacements + an unsigned event
    PERSIST the replacements                ← the dangerous moment
    sign and wrap the event locally
    publish it to the relay
```

The two signing steps are pure functions: no network, no round trip, a library
call inside your script. They are also the two places this service is
structurally unable to stand in for you, which is what makes a public spending
endpoint defensible at all.
