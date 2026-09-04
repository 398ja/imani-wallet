# Does the API cover what the UI can do?

An operation-by-operation inventory, and a proposed endpoint for each.

Asked because the wallet API is public surface: whatever it omits, an
integrator cannot automate, and whatever it adds is a promise we keep.

## The answer in one line

**The API covers one journey out of roughly seven.** Five endpoints serve a
customer spending coupons. The entire merchant side — issuing, redeeming,
payment requests, cashback, terminals, subscriptions — has no API at all.

## What exists today

| endpoint | operation |
|---|---|
| `GET /v1/whoami` | identity check |
| `POST /v1/holding/value` | what a holding is worth, grouped by stall |
| `POST /v1/spend/plan` | which coupons would be spent, or why not |
| `POST /v1/spend/parts/prepare` | prepare one part, return an unsigned event |
| `POST /v1/spend/parts/gateway-request` | what to sign for the gateway |

That is the README's story: "a script that pays a supplier every Friday". It
is complete for that, and nothing below argues otherwise.

## The constraint every proposal below must satisfy

ADR 0001: the service holds **no key and no coupons**. ADR 0002: it has **no
code path capable of spending**, which is what makes a public spending endpoint
defensible at all.

So no endpoint here may hold key material, hold coupons between requests, or
spend on a caller's behalf. Three patterns already in the codebase satisfy
that, and every proposal reuses one:

- **Plan** — compute and return a decision. Nothing moves. (`/v1/spend/plan`)
- **Prepare** — return an *unsigned* event the caller signs and publishes.
  (`/v1/spend/parts/prepare`)
- **Courier** — return the exact bytes to sign for a *third party*, then
  forward the caller's signature verbatim. The service cannot forge it.
  (`/v1/spend/parts/gateway-request`)

A fourth is needed and does not exist yet:

- **Attest** — the caller submits state it already holds (transaction history),
  and the service computes a verdict over it. Needed because several UI rules
  are enforced against *local device history* the service cannot see. See
  "The hard one" below.

---

## Inventory

Ranked by how much an integrator would miss it. `lib` names the module that
already implements the logic, since pages hold no HTTP calls of their own —
the seam is already in the right place.

### 1. Redeem a coupon — the highest-volume merchant operation

`lib/vreq.ts`, `lib/redemptionLedger.ts` · `RedeemPage`

| operation | proposed | pattern |
|---|---|---|
| verify a presented coupon | `POST /v1/redeem/verify` | plan |
| check it against the ceiling | `POST /v1/redeem/check` | **attest** |
| accept it | `POST /v1/redeem/prepare` | courier |

**The blocker is real and worth stating plainly.** `checkRedemption` is the
only check that sees *across* redemptions — the one that notices the same £10
voucher being presented four times for £10. It sums prior redemptions from
**local transaction rows**, deliberately:

> "Local rows are authoritative here, by design: a merchant who accepted a
> redemption with no signal must be able to enforce their own ceiling without
> asking anyone."

A stateless service has no such rows. Two honest options:

- **(a)** the caller sends its own prior redemptions for that `voucher_id`, and
  the service computes the verdict. Stateless, and the caller already holds the
  data. The ceiling is then only as good as what the caller sends, which must
  be said in the README rather than implied.
- **(b)** the endpoint returns the signed `faceValue` cap and states that
  cross-redemption enforcement is the caller's. Weaker, but it does not pretend.

Recommend **(a)**, documented as (b) — compute it for them, and be explicit
that the input is theirs.

### 2. Issue a coupon

`lib/issue.ts` · `SellPage`

| operation | proposed | pattern |
|---|---|---|
| what minting would cost/produce | `POST /v1/issue/plan` | plan |
| the gateway request to sign | `POST /v1/issue/gateway-request` | courier |
| the delivery DM to sign | `POST /v1/issue/deliver-request` | prepare |

`issueAndDeliver` is three phases — mint, poll until the token exists, deliver
— with a **partial-failure window the UI already handles**: a coupon can be
issued and undelivered, and the error names the voucher so it can be recovered.
An API must expose that seam rather than hide it behind one call, or a failed
delivery becomes an integrator's silent loss.

The poll (`waitForToken`) is the awkward part: issuance returns `PENDING`
behind a bolt11 top-up and only later carries a token. Either the API polls and
holds the connection ~10s, or it returns a `voucher_id` and the caller polls.
**Prefer the latter** — a held connection is a timeout waiting to happen, and
the caller already needs to persist the id to be crash-safe.

### 3. Payment requests

`lib/vreq.ts` · `PayPage`, `ReceivePage`

| operation | proposed | pattern |
|---|---|---|
| create a request | `POST /v1/requests/create` | plan (pure) |
| match a payment to it | `POST /v1/requests/match` | attest |
| expire / reconcile | `POST /v1/requests/reconcile` | attest |

Almost pure functions over caller-supplied state, so these are the cheapest to
expose and among the most useful: this is how an EPOS asks for money.

### 4. Cashback

`lib/cashback.ts` · `CashbackIssuePage`, `CashbackRedeemPage`

| operation | proposed | pattern |
|---|---|---|
| generate a code | `POST /v1/cashback/generate` | courier |
| look up by code | `GET /v1/cashback/{code}` | plan |
| claim | `POST /v1/cashback/claim` | courier |

Straightforward: already a gateway call behind a signature.

### 5. Terminals — and a security gap this inventory surfaced

`lib/terminalRoster.ts`, `lib/credentialRevocation.ts`, `lib/terminalEnrol.ts`

| operation | proposed | pattern |
|---|---|---|
| list the roster | `POST /v1/terminals/list` | attest |
| mint a credential | `POST /v1/terminals/enrol-request` | courier |
| revoke | `POST /v1/terminals/revoke-request` | courier |

**Two findings, neither of which is an API problem.**

**(i) Owner-side revocation never reaches the mint.**

*Corrected from my first reading, which treated the delay itself as the bug. It
is not: ADR 0005 decides revocation is "bounded, not immediate", so a till
re-authenticates once a trading day rather than mid-shift. A revoked terminal
trading on for a while is designed.*

The gap is that the bound has nothing enforcing it. Traced through the code and
pinned by `src/lib/__tests__/ownerRevocationGap.test.ts`:

- `TerminalsPage:112` — the owner's only revoke button — calls
  `revokeTerminal(stallPubkey, terminalPubkey)`.
- `terminalRoster.revokeTerminal` sets `revokedAt` on a **local roster row**
  and returns. No mint call, no network.
- The revocation that bites is `revokeCredential`, which *spends* the
  credential. Its only non-test caller is `terminalDecommission.ts`, which runs
  **on the device being decommissioned**.
- `terminalLogin` refuses on `unspent === false`, a definite SPENT from the
  mint. It never reads the roster.

So the twelve-hour bound assumes the credential is dead and only the *session*
lingers. With the credential still live, each expiry is followed by a fresh
login that succeeds: the delay is not twelve hours but indefinite.

`isRevoked` exists, is exported, and has **no caller outside its own module**,
consistent with the mark being a display concern only. And
`terminalDecommission` carries the comment "the owner has revoked it remotely
and the device is finishing the job" — which no code path makes true.

Five tests pin this, with a mutation control: removing the `unspent === false`
refusal fails the control arm, so they are not passing vacuously.

**(ii) P2PK makes owner-side revocation harder, not easier.** Now that
credentials are locked (ADR 0008, PR #48), spending one requires a **witness
from the device key** — which the owner does not hold, by design. So "revoke
from the owner's phone" cannot be done by spending. It needs either a
gateway-side revocation list, or an issuer-spendable path designed on purpose.

`credentialRevocation.ts` has no witness handling at all, consistent with it
only ever having run on the device.

**This is the one item I would not spec further until you have ruled on it.**

### 6. Subscriptions / licences

`lib/licenceIssue.ts`, `lib/licenceStatus.ts` · `SubscriptionPage`

| operation | proposed | pattern |
|---|---|---|
| current status | `POST /v1/licence/status` | attest (offline verify) |
| buy / renew | `POST /v1/licence/purchase-request` | courier |

`licenceStatus` is already an offline verification over a voucher the caller
holds, so it maps to **attest** almost unchanged.

### 7. Reads

`lib/stats.ts`, `lib/merchants.ts` · dashboard, records, merchant lookup

| operation | proposed |
|---|---|
| dashboard totals | `POST /v1/reports/dashboard` |
| transactions / coupons | `POST /v1/reports/records` |
| resolve a stall | `GET /v1/stalls/{nip05}` |

Computed over caller-supplied rows, matching `/v1/holding/value`. Cheap, and
probably the first thing a bookkeeping integration asks for.

---

## Deliberately never

Not "not yet". Each would break something specific.

| area | why |
|---|---|
| **Backup / recovery** (`lib/backup.ts`) | handles key material. An endpoint that emits or ingests it undoes ADR 0001 outright. |
| **Security / PIN** (`SecurityPage`) | device-local by definition; remote administration is an attack surface with no user. |
| **Settings, profile, onboarding, welcome, scan** | presentation and device state. `scan` is a camera. |
| **Login / logout** | there is no session to create. Identity *is* the signing key. |

`profile` is arguable — a stall's public metadata is not secret, and bulk
updates have a use. Listed here as out of scope; say if you want it in.

## Recommended sequence

1. **Reads** (§7) and **payment requests** (§3) — near-pure over supplied
   state, no new custody question, immediately useful.
2. **Redeem** (§1) — highest value, but needs the ceiling ruling first.
3. **Issue** (§2) — needs the poll/partial-failure shape settled.
4. **Cashback** (§4), **licences** (§6).
5. **Terminals** (§5) — blocked on the revocation finding.

## Open questions

1. **Redemption ceiling**: caller-supplied history, or documented as the
   caller's responsibility? Affects whether the API can be trusted to prevent
   double-redemption at all.
2. **Owner-side revocation**: finding (i) is now pinned by tests, so the
   question is not whether but what to do. The bound in ADR 0005 is sound; it
   just needs something to enforce it. P2PK (ii) rules out the obvious fix, so
   the options are a gateway-side revocation list, an issuer-spendable path
   designed on purpose, or accepting that only the device can revoke itself and
   saying so on the owner's screen. This wants a ruling before an endpoint.
3. **Issuance polling**: hold the connection, or return an id and let the
   caller poll? Recommend the latter.
4. **Terminal-scoped API keys**: should a terminal's own credential authorise
   API calls, so an integrator can act as a till rather than as the stall?
   Currently every API caller is the stall.
5. **Profile writes**: in or out?

## What this document is not

An implementation plan. No endpoint here is designed to the level of request
and response shapes, error cases, or idempotency — that is per-ticket work
once the five questions above are answered.

Nothing here has been built or tested. It is an inventory read off the code,
and the two terminal findings in §5 are the parts most worth checking before
anything is written.
