# The caller holds the key, and the coupons

The wallet API gives programs an alternative to the browser app. It holds
**neither** the customer's key nor their coupons: callers pass their coupon state
in with each request and receive the new state back, and authenticate each
request with a NIP-98 signature rather than a session.

The obvious alternative was a server-side coupon store keyed by pubkey, which
would make callers far simpler — no state to persist, no lost-response problem.
We rejected it because coupons are bearer instruments, so holding them is custody
of value regardless of who holds the key. A breach of a custodial wallet API is a
theft; a breach of this one is a denial of service. That asymmetry is worth the
burden it puts on callers.

## Consequences

- A caller that loses a response loses the coupons it described. Callers must
  persist state transactionally around each call, and this must be said plainly
  in the API documentation rather than discovered.
- The service is stateless and horizontally scalable, and needs no database.
- Reads are `curl`-friendly; spending is not, because it requires signing.
- No client library is planned, in any language. The REST surface is the
  deliverable. `imani-sdk-node` is not being extended and has no live dependants.
