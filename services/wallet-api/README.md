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

### `GET /metrics`

Unauthenticated counters: requests, errors, refusals by reason, validation
errors, guard statistics, and live store sizes so boundedness is observable.

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

## What is not here yet

Preparing a part. `/v1/holding/value` and `/v1/spend/plan` are both reads; the
prepare endpoint comes next. When they arrive, the service will build an unsigned event and hand it
back for you to sign — it cannot sign, by construction, and
[ADR 0002](../docs/adr/0002-the-api-plans-the-caller-signs.md) records why.
