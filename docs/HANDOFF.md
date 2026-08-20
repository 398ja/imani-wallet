# Briefing — merchant coupon wallet, resume from NAP authorization

Paste the block below into a fresh session started in `/home/eric/IdeaProjects/imani-wallet`.

---

You are picking up a working prototype mid-flight. **Read
`docs/superpowers/specs/2026-08-11-farmer-coupon-wallet-design.md` before touching anything**
(its filename and its wording predate the farmer → merchant rename; it is kept as the record of what
was decided that day) —
§10 (what is proven vs merely written), §11 (issuance, NIP-17 delivery, the legacy bridge) and
especially **§15, the merchant role**, which is the most recent work and records every trap that has
already cost a debugging round.

## What this is

A coupon wallet for merchants of any kind — it began at farmers' markets, hence the older naming in
the spec: React 19 + Vite + TS, consuming imani-apps' `@imani/*` packages and nap **aliased from
source** (`vite.config.ts` — no build step). It now serves **both sides**: customers hold coupons and
pay merchants; merchants issue coupons and take them as payment.

## Current state

The merchant merge is **done and verified end to end** (§15). Registration asks Customer or Merchant
via a switch on the account form; a merchant gets a till with Sell and Redeem, a stall record, stats,
transaction and issued-coupon screens. Sell issues a real coupon and delivers it by NIP-17 DM;
Redeem shows a NUT-18V request. Logout wipes the device and logging back in **with only the nsec**
rebuilds the identity, the stall and every sale — each issuance is published as a kind-30078 event,
NIP-44 encrypted to the merchant's own key (§15.12).

**In flight: NAP roles and permissions.** Plan at
`~/.claude/plans/merge-possa-merchant-into-imani-wallet-recursive-bubble.md`. The headline finding is
that **NAP already implements all of it** — `@RequiresPermission` / `@RequiresRole` /
`@RequiresSession`, `NapPermissionInterceptor`, `SessionRecord.roles/permissions`, `AclResolver`,
`PermissionRegistry`. This is adoption, not a feature build. Phase 1 (nap-java 0.1.1 → 0.6.0,
inherited from imani-bom) is done. Phase 2 is half done.

## Your task, in order

1. **`mvn -pl gateway-core-rest test` in imani-gateway-core, in full.** Phase 1 was reported as
   building on the strength of `mvn compile`, which only covers main sources. **Test scope was never
   compiled**, and the first test file touched did not compile: `NapProperties` went from 12 record
   components to 22. Expect more of the same shape. This is the honest status of the upgrade.
2. **Repoint the role source.** `MerchantAclService` still reads `nap_acl`. The design has the
   kind-30078 stall record (`d=imani:merchant`, `active: true`) as the truth, read through
   `NostrQueryPort`, which gateway-core already has. Marked `ponytail:` in the class javadoc.
   **Gated on the nostrdb card** — the cache cannot reliably answer a kind-30078 query by author and
   d-tag today.
3. Phase 3 (portal enforcement via an `X-Auth-Permissions` edge header) and Phase 4 (the wallet reads
   `useNapSession().hasPermission` instead of its own `isMerchant()`).

## Traps that will cost you a round

Each of these was paid for once already.

- **gateway-portal's NIP-98 filter does not authenticate.** A correctly-formed header with a matching
  `u`, sent straight to :28084, still returns 401. Only the edge path works. Vite plays the edge
  proxy (`/api/v1/portal` rule); the browser sends only its pubkey and the proxy adds the secret.
- **403 with an empty body from the portal means "no such route."** A junk path returns the same.
  Calibrate before concluding an endpoint exists.
- **customer-wallet's relay ingest dies silently** — nostrdb answers `total=0` for everything while
  the relay plainly holds the events. `docker restart customer-wallet-test`. Its health endpoint says
  `OUT_OF_SERVICE` **even when working**, so health is not the signal; compare against the relay.
- **The gateway stamps `face_decimals: 2` on every currency**, so a 2,500 XAF coupon reaches the
  customer labelled 25.00. **Do not "fix" this by scaling the input** — backing is 1 sat per minor
  unit, so it over-backs a hundredfold and the token grows too large to deliver (a flat 413). §15.9.
- **`GET /api/v1/portal/vouchers` never lists Sell-flow coupons.** It merges kind-30078 payment
  requests and the cashback table only. The merchant's history is client-held and relay-backed.
- **Issuance waits are load-bearing**: poll on `token` presence (not `expires_at`), send `expires_at`
  as epoch **seconds**, and `relay_urls` must be the **internal docker** URL — the gateway publishes
  from inside the network.
- **imani-bom 0.1.40 is installed locally only**, not deployed to reposilite. CI will not see it.

## Standing instruction: distrust green

The characteristic failure here is **looking like success**. Verify by observation — response bodies,
IndexedDB, relay queries — never by absence of errors. `node scripts/query-relay.mjs <pubkey> [kind]`
reads straight off strfry, bypassing the gateway's cache. Say what you ran and what it printed; label
anything unverified.

## Environment

```bash
./deploy/up.sh                 # start;  ./deploy/up.sh ps  for status
./scripts/seed-domain.sh       # once per stack, before any account is registered
npx vite --port 5199
```

| Service | Port | Role |
| --- | --- | --- |
| account-app | 28081 | NAP auth (`/api/v1/auth/*`), db `imani_core` |
| customer-wallet | 28082 | wallet, nostrdb, DM |
| gateway-portal | 28084 | issuance, dashboard, db `imani_portal` |
| mint | 27777 | Cashu |
| relay (strfry) | 27778 | Nostr |

The two gateways use **different databases**, which is why the portal cannot validate an account-app
session and why Phase 3 uses an edge header instead.

Checks that must stay green: `npx tsc -b --force`, `npx vitest run` (257 tests).

## Tracking

The kan board (`kan` MCP, board `imani-apps`) carries the history. Open items:

- **To Do** — *imani-wallet reads kind-30078 straight from the relay, bypassing the gateway's nostrdb
  cache.* Blocks task 2 above, and matters more than it reads: the browser can only reach strfry
  because this dev stack publishes the port. A deployment that does not expose it loses the merchant
  role and the whole issuance ledger.
- **In Progress** — *gateway-core: coupon permission model, and the ACL resolver no longer fails
  open.* Records what landed and what remains.
- **Done** — the merchant merge, and the nap-java 0.6.0 bump.
