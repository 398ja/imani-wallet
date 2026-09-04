# 08: Cashback

**What to build:** `/v1/cashback/generate`, `/v1/cashback/{code}` and
`/v1/cashback/claim`. Couriers, since the underlying calls are already
signature-guarded gateway operations.

**Located, and it is genuinely blocked.** Cashback is served by gateway-core at
`/api/v1/cashback/generate` — not the portal path the app uses — and it does not
accept NIP-98:

```
POST 28081/api/v1/cashback/generate  (NIP-98 signed)
  401  {"code":"AUTH_001","message":"API key required"}
```

**An API key is exactly what this service must not hold.** ADR 0001's whole
argument is that a breach here is a denial of service rather than a theft, and
that holds only because there is no credential to steal. A shared cashback key
would be a way to generate cashback for anyone who reached this service.

Three ways forward, and the choice is a product one:

1. **Cashback accepts NIP-98**, like every other operation a merchant performs.
   Then this ticket is an ordinary courier and takes an afternoon.
2. **The caller holds its own API key** and this service couriers the request
   without ever seeing it — possible, but it means telling integrators to
   manage a second credential alongside their key, which is the thing the whole
   API avoids.
3. **Cashback stays browser-only.** Honest, and worth saying out loud rather
   than leaving a ticket open that nobody can start.

Recommend (1). It is the only option that leaves the API's story intact.

**Blocked by:** an API-key auth model that ADR 0001 forbids this service from satisfying

**Status:** blocked

- [ ] Where cashback is actually served is established before endpoints are designed.
- [ ] A code can be generated, looked up, and claimed by a caller holding only a key.
- [ ] A claimed code cannot be claimed twice.
- [ ] An unknown or expired code is refused with a reason that distinguishes the two.
- [ ] A probe runs generate → look up → claim against the live service.
