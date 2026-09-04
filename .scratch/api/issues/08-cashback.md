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

**Blocked by:** 03 (shares the courier plumbing), and a portal image that
includes `PortalCashbackController`

**Status:** ready once deployed

- [ ] A code can be generated, looked up, and claimed by a caller holding only a key.
- [ ] A claimed code cannot be claimed twice.
- [ ] An unknown or expired code is refused with a reason that distinguishes the two.
- [ ] The public read paths stay public — a customer redeeming a code holds no key of ours.
- [ ] A probe runs generate → look up → claim against the live service.
