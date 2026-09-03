# A voucher-guarded request presents the voucher and is signed by its lock key

The wallet API authenticates a caller by NIP-98: the identity of a caller **is**
the pubkey that signed (ADR 0001). Some resources a caller reaches for are not
guarded by identity at all, but by a Cashu voucher P2PK-locked to a key —
mint-backed authorisation, as terminals already use for login (ADR 0005, NAP
extension 0001).

When such a resource is reached through this API, the voucher travels in the
**request body**, and the request's NIP-98 event MUST be signed by the key `K`
that the voucher is locked to. Authorisation is that equality, not the presence
of the voucher.

```
voucher proof --P2PK--> K <--signs-- the NIP-98 event for this request
```

The obvious alternative was a header: `X-Voucher`, alongside the existing
`Authorization`. We rejected it because **NIP-98 signs the body, not the
headers**. The `payload` tag is `sha256(body)` and the signature covers `u`,
`method` and that hash — nothing else. A voucher in a header is unsigned, so a
proxy, a retry layer or anything else in the path may strip it, replace it, or
attach it to a different request, and every one of those produces a request that
verifies perfectly. In the body it is inside the hash, and any of those
tamperings fails as `payload-mismatch` before reaching any logic. This is the
same reason `gatewayAuthorization` is a body field on `/v1/spend/parts/prepare`
rather than a header, and the same reason NAP puts the credential in the
completion body rather than beside it.

The second alternative, and the more tempting one, was to treat the voucher as a
bearer credential: present it, and be authorised. Extension 0001 §2 gives four
independent reasons this is unsafe, and all four apply here unchanged. A voucher
carries no challenge, so replay is unbounded in time. It is readable by anything
in the path, and this service already refuses to put a credential anywhere
readable. Proving a proof is live by spending it destroys the voucher on every
request. And a bearer token yields no principal to key a rate limit, an
idempotency record or an audit line on — all three of which this service keys on
the verified pubkey.

The P2PK binding answers all four. Possession of the voucher without `K` proves
nothing, because the request cannot be signed. Possession of `K` without the
voucher proves nothing, because there is no authorisation to resolve. Freshness
and replay are already handled by the guards, which key on the signature this
design requires anyway.

## Verification, and the order it happens in

Inserted after authentication and the guards, before any work:

```
verifyNip98              → auth.pubkey
guards                   → replay, idempotency, throttling
voucher (body)           → a. mint_url matches the allowlist
                         → b. NUT-12 DLEQ verifies against the keyset
                         → c. parse the secret, extract K
                         → d. K === auth.pubkey
                         → e. issuer_sig verifies; (mint, issuer) allowlisted
                         → f. expires_at is in the future
                         → g. NUT-07 checkstate returns UNSPENT
                         → h. grant() → what this caller may do
```

Three orderings are load-bearing rather than incidental.

**(a) first.** Never make an outbound request to a URL taken from a request
body. The allowlist is matched against, never selected by, the caller's
`mint_url` — the same rule the audience allowlist already follows, and the
highest-severity thing to get wrong here.

**(d) before (g).** Reject a mismatched binding locally, before spending a
network round trip and before telling the mint anything.

**Everything after authentication.** A caller that has not proven key control
must never reach the mint, or this endpoint becomes a free oracle for
state-checking arbitrary proofs.

## Consequences

- **Two signatures on one request, again.** A caller reaching a voucher-guarded
  resource signs as `K` rather than as itself, so `K` is the identity the guards,
  the idempotency records and the metrics all key on. A caller holding several
  vouchers is several callers as far as this service is concerned, and its rate
  limit is per voucher rather than per operator. That is the correct shape — the
  authorisation is what is being throttled — but it surprises anyone expecting
  one budget per integration.

- **`K` SHOULD be disposable and per-voucher.** Nothing enforces it. A caller
  that locks a voucher to its long-term identity key gets today's linkability
  back, and worse, makes its idempotency records and rate limit shared across
  everything else it does.

- **Six of the seven checks are permanently offline; only liveness is not.**
  Worth stating as a table, because "the mint is required" is true of one row and
  gets read as true of all seven:

  | check | needs the mint? |
  |---|---|
  | `mint_url` allowlisted | no — local config |
  | DLEQ verifies | keyset only, cached |
  | `K === auth.pubkey` | no — a comparison |
  | `issuer_sig` verifies | no — the wallet already does this offline |
  | `(mint, issuer)` allowlisted | no — local config |
  | `expires_at` in the future | no — local clock |
  | **NUT-07 `checkstate`** | **yes, irreducibly** |

  The issuer signature is the one most often assumed to need a network call. It
  does not: `verifyVoucher` in `src/lib/voucherToken.ts` runs in the browser, and
  `preparedPart.test.ts` exercises it against a coupon this API really split.

  Liveness cannot join them, and not for want of engineering. `y =
  hash_to_curve(secret)` is what NUT-07 is keyed on, and a proof's spent-ness is
  a fact about the mint's spent-set that exists nowhere else by construction. No
  signature can encode "not yet spent", because spending happens after signing.

  **So the practical dependency is much narrower than "every request needs the
  mint".** Every *denial* on a forged signature, an expired voucher, a wrong lock
  key or an untrusted issuer is local, and happens before any outbound call — the
  ordering above already requires that for SSRF reasons, and it pays twice. The
  mint is contacted only when a request would otherwise be **allowed**.

- **An unreachable mint degrades rather than denies, and the split is ADR 0003's.**
  A short-TTL cache on `checkstate`, and a degraded answer that is **redeem-only**
  rather than deny-everything. Redemption must never need the network to
  authorise it, and ADR 0003 establishes that by measuring the flow with the
  browser context set OFFLINE rather than asserting it; issuance is value-bearing
  and waits.

  The asymmetry is what makes the trade affordable. A revoked terminal that
  redeems for a few more minutes sends coupons to the stall that issued them, and
  a terminal never holds value (ADR 0005) — so the error is recoverable. A
  revoked terminal that *issues* creates money that should not exist, and nothing
  downstream catches it. Only the second must wait.

  The cache TTL is a security parameter, being the maximum staleness of an
  authorisation decision, and belongs beside the guard TTLs rather than being
  tuned for latency. `nap-voucher`'s own `availability.ts` refuses to default the
  degraded grant for the same reason: a default of the full grant is the
  vulnerability, and a default of nothing is a session that silently does nothing
  and reads as though it works. It also takes a `destructivePermissions` list and
  throws at wiring time on overlap, which is the only mechanical check that
  "reduced" is true rather than a promise in a comment.

- **Statelessness removes two of the extension's hardest problems.** There is no
  session to outlive its credential (§7.1) and no re-resolution that has lost the
  credential (§7.2), because every request carries its own. What NAP bounds with
  `maxSessionLifetimeSeconds`, this API gets for free — the staleness window is
  the cache TTL and nothing else.

- **A voucher-guarded resource on the GATEWAY repeats the forwarding problem.**
  This service holds no credential of its own and cannot mint one (ADR 0002), so
  the caller signs for the gateway with `K` and the service forwards that header
  verbatim, exactly as `gatewayAuthorization` already does. The service stays a
  courier; the pattern generalises rather than needing a second mechanism.

- **Verification never spends.** The state check is read-only. Spending would
  burn the voucher on every request and would make a retried idempotent request
  destructive, which is the one thing the idempotency guard exists to prevent.

- **Denials are indistinguishable to the caller and distinct in the metrics.**
  Every voucher failure answers the same 401, for the same reason every NIP-98
  failure does; the reason lives in a counter an operator can alert on. This
  needs a new `voucherRefusals` counter beside `recipientRefusals` — an
  authorisation denial that reaches no metric is invisible on exactly the surface
  where it matters most.

## Relays are not a substitute for the mint

Asked and answered during review, and recorded because the idea is a good one
that fails for a reason worth knowing: could a relay carry a list of burned
vouchers, so liveness is answered offline and relays act as mint backups?

**No, and the obstacle is Cashu itself rather than a missing feature.**

The infrastructure exists and is further along than it looks. `cashu-ledger`'s
trace publisher already signs with the **mint's own key**, over a canonical
NIP-01 id, through a durable outbox — so a burn is already a mint-signed fact
rather than an issuer's claim. `OperationKind.isMintStateChange()` names exactly
the operations that consume proofs, and every privacy mode retains `y`, which is
the same key NUT-07 is keyed on. It would join perfectly.

Three things stop it, and the first is decisive:

1. **A public burn list *is* the transaction graph.** The trace specification
   §7.2 is explicit: capturing the chain of custody "operationally undoes"
   Cashu's sender/receiver unlinkability, which is "acceptable inside an operator
   boundary but unacceptable as a public service." `PrivateRelayGuard` therefore
   refuses to start against any public relay **in every privacy mode**, including
   `MINIMAL`. Publishing burns publicly would take a system engineered so nobody
   can build that graph and hand the graph to everybody.

   `y = hash_to_curve(secret)` is unsalted, so a public list is not a disclosure
   but an **oracle**: anyone holding a candidate secret — every merchant who ever
   received the coupon — could test membership and correlate. §7.2 names this
   directly.

2. **A private relay shares the mint's failure domain.** Even setting privacy
   aside, the only permitted target runs beside the mint, so it is unavailable in
   the same outage. It would be a latency win inside one operator's boundary, not
   an availability one.

3. **The stream is async and may be lossy.** The publisher enqueues and returns,
   so a spend precedes its published burn; and three of four `OverflowPolicy`
   values may drop events, tagging themselves so "consumers can interpret gaps."
   A revocation list with sanctioned gaps cannot be relied on.

There is also a direction argument that holds regardless of all three. A relay
can only ever prove a voucher **is** burned; it cannot prove one is **not**,
because absence on a best-effort relay is not evidence of absence. Substituting
relays for NUT-07 would silently convert a fail-closed check into a fail-open
one.

**What would remain sound** is a burn watcher used strictly as a negative
channel, inside an operator boundary: a seen burn denies immediately and offline,
and an unseen burn changes nothing. That only ever refuses, so the unsafe
direction is unreachable, and it would cut revocation latency from the cache TTL
to seconds. It is an optimisation to this ADR, not an alternative to it, and it
is not required for a first implementation.

A genuinely public revocation list would need per-burn random tags carried by the
holder rather than `y` — a different credential format, not a different relay
setting.

## What is settled upstream, and what is not

The composite `P2PK_VOUCHER` kind, which ADR 0005 and extension 0001 §5.3 both
recorded as blocking, **is released**. The three pieces landed together and
`imani-bom` pins them as a set:

| | version | what it contributes |
|---|---|---|
| `cashu-lib` | 0.29.0 | defines the composite NUT-10 kind |
| `cashu-voucher` | 0.13.0 | signs it |
| `cashu-mint` | 0.35.0 | enforces the voucher conditions and the P2PK witness together |

They are pinned together deliberately, and the BOM says why: a 0.29.0 cashu-lib
against a mint older than 0.35.0 dispatches the kind to a condition that never
checks a witness. That is the advisory-lock failure in a different disguise —
this service could verify the binding and the mint could not, so a thief could
still spend the proof. **Do not mix them**, and treat a deployment that has
cashu-lib 0.29.0 with an older mint as unsafe for this design rather than merely
untested.

`P2PKVoucherSpendingCondition` is what closes it: it runs both halves and
documents why either alone looks like it works. Voucher checks only leaves the
lock advisory; P2PK checks only honours a forged or expired voucher locked to the
spender's own key.

So this ADR is implementable now. ADR 0005's closing line — "it cannot ship
before the mint does" — has been satisfied, and the terminal ticket parked behind
it (`.scratch/terminals/issues/10-real-credential-path.md`) is unblocked on this
count.

One blocker remains, and it is not in this API's path: `SignedVoucher` wraps a
`VoucherSecret` while `P2PKVoucherSecret extends P2PKSecret`, so **the Nostr
ledger still cannot represent a P2PK-locked voucher**. That blocks a revocation
watcher, not this design. Its absence is what makes the cache TTL above the only
thing bounding staleness, and it is why that TTL should be short.

One caveat a reader will hit: the kind is deliberately **not advertised in
`/v1/info`**, because it is an Imani extension with no NUT number and no
published vectors. A caller cannot discover it from the mint. That is the correct
outcome while it is private — an unknown kind is rejected at parse rather than
treated as anyone-can-spend — but it means support is something a deployment
knows from its pins, not something it can probe for.
