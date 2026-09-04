# 08: Cashback

**What to build:** `/v1/cashback/generate`, `/v1/cashback/{code}` and
`/v1/cashback/claim`. Couriers, since the underlying calls are already
signature-guarded gateway operations.

**Locate the service first.** A signed POST to
`/api/v1/portal/cashback/generate` returns 404 on gateway-customer: cashback is a
portal operation and the portal (28084) is not running on this stack. That has to
be resolved before the endpoints can be probed, which is why this is sequenced
after the operations that work today.

**Blocked by:** 03 (shares the courier plumbing)

**Status:** todo

- [ ] Where cashback is actually served is established before endpoints are designed.
- [ ] A code can be generated, looked up, and claimed by a caller holding only a key.
- [ ] A claimed code cannot be claimed twice.
- [ ] An unknown or expired code is refused with a reason that distinguishes the two.
- [ ] A probe runs generate → look up → claim against the live service.
