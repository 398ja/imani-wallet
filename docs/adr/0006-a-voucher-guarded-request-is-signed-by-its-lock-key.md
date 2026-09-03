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

- **The mint becomes an availability dependency of every guarded request**, not
  of a login. This is where a stateless API is worse than NAP's session model
  rather than better. NAP checks state once at `/auth/complete` and lives with a
  bounded staleness window; here there is no session to carry a decision, so the
  honest reading of "evaluate permissions on every request" is a NUT-07 check on
  every request. Extension 0001 §7.1 calls per-request state checks a trap, and
  it is right.

  The mitigation is the asymmetry this repo already applies to redemption and to
  the recipient check: **a short-TTL cache on `checkstate`, and a degraded answer
  that is redeem-only rather than deny-everything.** Redemption must never need
  the network to authorise; issuance is value-bearing and can wait. The cache TTL
  is a security parameter, being the maximum staleness of an authorisation
  decision, and belongs in the same conversation as the guard TTLs rather than
  being tuned for latency.

- **Statelessness removes two of the extension's hardest problems.** There is no
  session to outlive its credential (§7.1) and no re-resolution that has lost the
  credential (§7.2), because every request carries its own. What NAP bounds with
  `maxSessionLifetimeSeconds`, this API gets for free — the staleness window is
  the cache TTL, and nothing else.

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
