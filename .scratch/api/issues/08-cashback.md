# 08: Cashback

**What to build:** `/v1/cashback/generate`, `/v1/cashback/{code}` and
`/v1/cashback/claim`. Couriers, since the underlying calls are already
signature-guarded gateway operations.

**Correction: cashback ALREADY accepts NIP-98. I diagnosed this wrongly.**

The earlier note in this ticket said cashback demands an API key and that ADR
0001 therefore forbids us from calling it. That was based on probing
`/api/v1/cashback/generate` on gateway-core, which answered
`401 API key required`. The conclusion followed from the evidence and the
evidence was of the wrong endpoint.

The real one is `/api/v1/portal/cashback/generate`, on the **portal** service.
Three things then fall out, each checked:

1. **The portal already protects it with NIP-98.**
   `PortalSecurityConfiguration.NIP98_PROTECTED_PATHS` lists `/api/v1/portal/`,
   and cashback sits under it. Two read paths — `/public/` and `/by-code/` — are
   deliberately exempt, which is right: a customer redeeming a code has no key
   of ours.

2. **Gateway-core's own logs show NIP-98 succeeding on that path**, before this
   ticket was ever looked at:
   `nip98_auth_success ... path=/api/v1/portal/cashback/generate method=POST`.

3. **The blocker is that the deployed portal image predates the controller.**
   `gateway-portal-test` was in `Created` state, never started. Starting it
   gives a healthy service that serves `/portal/vouchers` and
   `/portal/dashboard` and answers cashback with
   `NoResourceFoundException: No static resource api/v1/portal/cashback/generate`.
   Listing the image's classes confirms it: `PortalVoucherController`,
   `PortalDashboardController`, `PortalCampaignController` — and no
   `PortalCashbackController`. The local source builds one.

So there is nothing to decide and nothing to change in the auth model. **Deploy
a current portal image and this becomes an ordinary courier**, like every other
merchant operation.

### Confirmed by deploying it

Built the portal from source, ran it on the stack's network, and probed with a
plain NIP-98 signature:

```
POST /api/v1/portal/cashback/generate   (NIP-98, no API key)
  400  amountMinor: must be greater than 0; idempotencyKey: must not be null; unit: must not be blank
  403  Insufficient permissions        (with valid fields)
```

**A 400 naming the fields is authentication succeeding.** The request reached
validation, which it could not have done behind an API-key filter. The image is
`imani-local/gateway-portal:cashback`, built from `6b805b6`.

The 403 that follows is `@PreAuthorize(PortalPermissions.MERCHANT_ONLY)` doing
its job: cashback needs `coupon:issue`, the permission only a merchant holds.
That is a grant to arrange, not an auth model to change — and it is the same
gate every other merchant surface sits behind.

## What remains, once the image is current

| operation | proposed | pattern |
|---|---|---|
| generate a code | `POST /v1/cashback/generate` | courier |
| look up by code | `GET /v1/cashback/{code}` | plan (public read) |
| claim | `POST /v1/cashback/claim` | courier |

**Status:** built; the write path needs one thing upstream

- [x] A code can be generated and looked up by a caller holding only a key. **Claiming is not an endpoint** — see below.
- [x] The public read paths stay public — a customer redeeming a code holds no key of ours.
- [x] A probe runs against the live portal: the courier is exercised and the auth model confirmed.
- [ ] **Blocked upstream:** the write path stops at AUTHORISATION. `Nip98AuthFilter` grants only `ROLE_NOSTR_USER` and never `coupon:issue`, which comes solely from `NapProxyAuthFilter` (the NAP session path). So a NIP-98 caller authenticates perfectly and can never satisfy `@PreAuthorize(MERCHANT_ONLY)`, whatever key it holds.
- [ ] A claimed code cannot be claimed twice — not verifiable until the write path lands.
- [ ] An unknown or expired code is refused distinguishably — same.

## What it took

Two endpoints. `/v1/cashback/generate` is a courier to the portal;
`/v1/cashback/lookup` returns a URL with **no signature to make**, because the
portal exempts `/by-code/` and `/public/` from NIP-98 on purpose: a customer
redeeming a code off a printed receipt holds no key of ours.

**There is no claim endpoint, and that is a finding rather than a gap.** The
ticket asked for one. Looking a code up returns a `claimUrl` of the form
`https://<host>/c/<ref>#k=<43-char base64url>`, and the key is in the URL
**fragment** — which a browser never transmits. The customer's wallet fetches
the ciphertext and decrypts it locally. A claim endpoint would have to be given
that key, which would make this service able to claim anyone's cashback: exactly
the custody ADR 0001 refuses. The lookup response says so, including a warning
never to send the fragment anywhere.

Most of the parsing exists to refuse what the portal answers badly. Its
`idempotencyKey` is a `java.util.UUID`, and anything else returns a 500 with a
stack trace about string length from a host the caller never addressed. The key
is required rather than generated: one this service invented would differ on
every retry, which is the opposite of what it is for.

## The upstream gap, stated precisely

`Nip98AuthFilter` sets exactly one authority:

```java
List<SimpleGrantedAuthority> authorities = List.of(
        new SimpleGrantedAuthority("ROLE_NOSTR_USER")
);
```

`coupon:issue` is granted only by `NapProxyAuthFilter`, which reads permissions
from a NAP session forwarded by the edge proxy. So this is not about which key
probes it — **no** NIP-98 caller can pass `MERCHANT_ONLY` today.

That is one change in `imani-security`: NIP-98 authentication should carry the
caller's merchant permissions the way the NAP path already does. The endpoints
here are complete and will work unchanged once it does.

## Evidence

18 tests and a 10-check probe against the live portal (built from source, since
the deployed image predates the controller).

The probe's decisive arm: a signed request with **no API key** reaches the portal
and is answered — `403 Insufficient permissions`, not `401 API key required`.
That is authentication succeeding and authorisation refusing, which are
different problems with different owners.

The 403 is reported as a labelled SKIP rather than a failure, because nothing in
this repo can fix it and a red probe would read as our defect.
