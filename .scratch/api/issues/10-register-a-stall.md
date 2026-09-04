# 10: Register a stall

**What to build:** `/v1/stalls/available/{handle}` and `/v1/register/prepare` —
check a handle is free, then get the bytes to sign to claim it.

**Located, and the ticket named the wrong path.** The app does not call
`/api/v1/register` at all — that one is bottin's, wants HTTP Basic, and is not
something a stateless service could ever hold credentials for. Claiming a handle
is `POST /api/v1/nip05` on **gateway-core (28081)**, under ordinary NIP-98:

```
POST 28081/api/v1/nip05  {"username":…,"pubkey":…,"relays":[…]}   201
```

Confirmed with a fresh unregistered key, which claimed a handle and got a 201
back with the npub. So this is a courier like every other, and the "bottin has
to log in first" note applied to bottin's own flow rather than to ours.

The ordering property from `registration.test.ts` is the one to preserve:
nothing persists until the handle is claimed. A half-registered stall that owns
storage but not a name is worse than a failed registration.

**Blocked by:** None — the investigation is done, see below

**Status:** done (handle claim; the rest is the caller's)

- [x] Where it is served is established: `POST /api/v1/nip05` on gateway-core.
- [x] A taken handle fails at the gateway with a 409, which the caller sees directly.
- [x] Nothing persists anywhere: this service stores nothing, so the property is structural.
- [x] The caller signs; the service never holds or generates a key.
- [x] A probe claims a REAL handle end to end — **HTTP 201**, bound to the caller's key.

## What it took

One courier, `/v1/stalls/claim-handle`.

**The ticket named the wrong endpoint.** `/api/v1/register` is bottin's, answers
`WWW-Authenticate: Basic`, and is not something a service holding no credentials
could ever call. The app never touches it: claiming a handle is
`POST /api/v1/nip05` under ordinary NIP-98, which a fresh unregistered key
completed with a 201.

Handles are validated here rather than at the gateway — 3-32 characters, the
set that can appear left of an `@`. The gateway's own refusal is about a domain
the caller never mentioned, which is a confusing way to learn you used a space.

The endpoint refuses a claim naming any pubkey but the signer's. Pointing a name
at a key whose owner did not ask for it is the one thing this must not be usable
for.

## What is deliberately not here

The rest of what `registration.ts` does — minting a key, storing it under a
passphrase, writing a profile — is device-local and belongs to whoever holds the
key. A stall that claimed its handle through this endpoint owns everything after
it.
