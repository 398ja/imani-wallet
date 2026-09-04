# 10: Register a stall

**What to build:** `/v1/stalls/available/{handle}` and `/v1/register/prepare` —
check a handle is free, then get the bytes to sign to claim it.

**Locate the service first.** A signed POST to `/api/v1/register` returns 404 on
gateway-customer; registration is account-app's (28081), and bottin has to log in
first because its own register endpoint reads the caller's identity. That chain
needs establishing before an endpoint wraps it.

The ordering property from `registration.test.ts` is the one to preserve:
nothing persists until the handle is claimed. A half-registered stall that owns
storage but not a name is worse than a failed registration.

**Blocked by:** None, but starts with an investigation

**Status:** todo

- [ ] Where registration is served is established before an endpoint is designed.
- [ ] A taken handle is reported taken rather than failing at claim time.
- [ ] Nothing persists until the handle is actually claimed.
- [ ] The caller signs; the service never holds or generates a key for them.
- [ ] A probe registers a REAL stall end to end.
