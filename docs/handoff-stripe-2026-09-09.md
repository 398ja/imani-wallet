# Handoff — Stripe card purchase, 2026-09-09

Written at the end of a session that started with "what card number do I use"
and ended two layers deeper. Everything below is verified against real Stripe
unless it says otherwise.

## Where you are

A card payment **succeeds** and the buyer is redirected to `/buy/success`. The
voucher is **not issued**. That is the one open problem, and its cause is known
and diagnosed — see [Tomorrow](#tomorrow-the-one-open-problem).

Two bugs were found and fixed on the way there. Both are committed.

---

## What was wrong, in order

### 1. A live card in test mode (your first 402)

`POST /v1/payment_methods → 402`. A real card number typed into a `cs_test_`
session. Stripe answers `card_declined / test_mode_live_card`.

Use `4242 4242 4242 4242`, any future expiry, any CVC, any postcode. No real
card can ever work on a test session. Nothing was charged and there is nothing
to cancel.

This one is worth remembering because it **sent the diagnosis the wrong way**:
it is a genuine card error, so it made the next failure look like a card
problem too. It was not.

### 2. Connected accounts were never asked to take cards — FIXED

`POST /v1/payment_pages/cs_.../confirm → 400`, from inside Stripe's own hosted
checkout, after a card had been typed. The account behind that session:

```
charges_enabled: true   payouts_enabled: true   details_submitted: true
requirements.currently_due: []      disabled_reason: null
capabilities: {transfers: active}   card_payments: unrequested
```

Read the last two lines together — that is the whole bug. Express grants
`transfers` by default, and **transfers alone are enough to set
`charges_enabled`**. Account creation set a type and a country and no
capabilities, and Stripe requests none by default.

So every flag we stored said the stall was ready to sell, and the stall could
not accept a card. `chargesEnabled` is the single field the wallet's Payments
screen renders and the merchant mirror republishes `acceptsCards` from, so this
put a Buy button in front of every shopper of a stall that could not sell. The
failure surfaced only in Stripe's UI, in a request our code never makes, with
nothing logged on our side because our side was never called.

**Fixed in `payment-adapter` `4a6c4f1`**, then **completed in `3bfcc41`** — see
[Review findings](#review-findings). Two changes, because they fail in
different directions:

- request `card_payments` (and `transfers`, explicitly) at account creation
- narrow `chargesEnabled` to require an **active** `card_payments` capability,
  because creation code cannot help the accounts that already exist

Verified live: old params returned `capabilities: {}`, new ones return
`card_payments: inactive` — asked for, pending onboarding. 11 new tests, both
mutations verified red.

**Fixed in `imani-wallet` `61018d5`**, hardened in `ef7eec8`:
`e2e/purchase.e2e.ts`, which holds the promise both `BuyPage` and `purchase.ts`
make in prose — that everything refusable is decided before a customer sees a
card form. Run with `npm run e2e:purchase`. Verified by mutation: flipping
`charges_enabled` back to true reproduced the incident exactly.

---

## Review findings

A review of the above found **the first fix was half a fix**, plus three ways
the test could mislead. All corrected.

### The important one: a second snapshot builder

`4a6c4f1` narrowed `chargesEnabled` in `StripeSdkConnectClient#toSnapshot` and
missed that `StripeConnectService#toSnapshot` also exists — it maps the
`account.updated` **webhook** and writes straight to the database.

It still read the raw flag. `account.updated` is the event most likely to
arrive right after a merchant touches onboarding, so the webhook would have
overwritten a correct `false` with the original lie at roughly the moment
someone checked whether the fix worked, by a path with no user action to blame.
The fix would have appeared to work, then silently undone itself.

Fixed in `3bfcc41`: the rule now exists once, in `CardChargeCapability`, and
both callers use it. `StripeAccountSnapshotConsistencyTest` asserts **no**
production file outside that class reads `account.getChargesEnabled()`, so a
third builder added later fails the build.

### The test fixture had already drifted

`61018d5` hardcoded a stall that has since **completed onboarding** — it now
reports `card_payments: active` and genuinely can take cards. The suite would
have failed with a message one word away from the expected one, reading like a
regression rather than stale data. `ef7eec8` adds a preflight that names the
cause, plus an exact button label and an event-based wait in place of a 3s
sleep.

---

## Tomorrow: the one open problem

**Stripe has no webhook endpoint registered, so no purchase is ever recorded.**

```
Stripe webhook endpoints configured:  0
STRIPE_WEBHOOK_SECRET in env:         absent
stripe_purchase rows:                 0
processed_stripe_webhook_event rows:  0
```

The architecture is fine and behaved correctly. `/webhook/stripe` is live:

```
POST /webhook/stripe → 400 {"message":"Missing required Stripe webhook field: id"}
```

Per ADR 0010 the payment is recorded **before** anything is issued, and the
purchase-issuer polls that debt table every 15s. No webhook → no debt → no
coupon. `success_url` is only a browser redirect; it carries no authority and
issues nothing. That is correct design, not the bug.

### Why it cannot work on localhost unaided

Stripe cannot reach `http://localhost:28087`. Pick one:

1. **Stripe CLI** (not installed): `stripe listen --forward-to
   localhost:28087/webhook/stripe`. Prints the `whsec_...` the verifier needs.
2. **A public tunnel** plus a registered endpoint. Closer to staging.

Either way `STRIPE_WEBHOOK_SECRET` must be set or every event is rejected with
"Missing Stripe webhook secret" (`DefaultStripeWebhookSignatureVerifier`).

**The CLI is a developer tool only.** Customers install nothing. In
staging/production `payment-adapter` has a public HTTPS URL, you register
`https://<domain>/webhook/stripe` once in the Dashboard, and Stripe POSTs to it
forever. The webhook is server-to-server and no customer is aware it exists.

### Your £12 is paid and undelivered

```
cs_test_a1m6FfH7bxwV7BSR7TKrCdnk  complete  paid  1200 gbp
metadata: {quote_id: a46c4755-4f8d-4c98-8552-bc9ec147f36e}
```

Once the webhook path works this event can be replayed so the voucher is
issued. I did not do it unasked — it mints value.

Note it carries **no `buyer_pubkey`**, only `quote_id`, so it was bought from
the public route with no wallet attached. Even with a working webhook that
particular purchase delivers by claim link rather than crediting an account.
Worth knowing before you conclude a retest has failed.

---

## Checked, and fine

- **Staging and production do not have Stripe configured at all** — no
  `STRIPE_ENABLED`, no keys, in either compose file. I checked because a silent
  "takes money, issues nothing" bug in staging would have been urgent. It is
  not there. Cards are local-only today.
- The old broken account `acct_1UDZ7BQ0Rz45vDTA` was repaired in place by
  requesting the capability, and **has since completed onboarding**. It now
  reports `card_payments: active`, `charges_enabled: true` with no requirements
  due — so that flag is now TRUE and CORRECT, which is what let your payment
  succeed. The fix agrees with it; nothing to undo.

## Suggested next, in order

1. **Wire up the webhook** (Stripe CLI is the quickest path) and confirm a
   `stripe_purchase` row appears.
2. **Replay the paid session** so the £12 delivers.
3. **Add a boot guard**: `stripe.enabled=true` with no `STRIPE_WEBHOOK_SECRET`
   is unsatisfiable — money moves and nothing arrives, silently. This is
   exactly the shape of the Connect/gateway flag mismatch you fixed in
   `4ab7bf7`, and deserves the same treatment.
4. ~~**Finish onboarding** for a stall~~ — **done**. `acct_1UDZ7BQ0Rz45vDTA`
   reports `card_payments: active` and takes real test cards, which is how the
   paid session above was created. An end-to-end success is now testable the
   moment the webhook is wired.

## Loose ends I left alone

- `payment-adapter-core/payment-adapter-rest/Dockerfile` builds a **thin jar**
  that dies with `no main manifest attribute`. I rebuilt the test container
  with `jib:dockerBuild` instead (jib is already configured in the pom). Real
  bug in a path someone will eventually trust.
- The test container was recreated by hand, not by compose:
  `docker compose -f docker-compose.test.yml` fails with "service bottin-api
  has neither an image nor a build context" because `PAYMENT_ADAPTER_IMAGE` and
  friends are unset in that shell. Its env was preserved to `/tmp/pa.env`.
- **Uncommitted in `imani-wallet`**, and not mine — `src/App.tsx`,
  `src/pages/PublicProfilePage.tsx`,
  `src/pages/__tests__/publicProfile.test.tsx`. Left untouched.
- Playwright MCP was installed and pinned to `@playwright/mcp@0.0.80` in
  `~/.jcode/mcp.json`. Note it ships `browser_run_code_unsafe`, which is
  RCE-equivalent by its own description.

## Useful commands

```bash
# what Stripe thinks of an account (the key is in the container env)
SK=$(grep '^STRIPE_SECRET_KEY=' /tmp/pa.env | cut -d= -f2)
curl -s -G https://api.stripe.com/v1/accounts -u "$SK:" -d limit=5

# what we think of it
curl -s http://localhost:28087/api/v1/stripe/connect/accounts/<pubkey>

# the mirror the purchase gate actually reads
docker exec imani-payment-db-test psql -U postgres -d payment_gateway \
  -c "select stripe_account_id, charges_enabled from connected_stripe_account;"

# did a purchase get recorded
docker exec imani-payment-db-test psql -U postgres -d payment_gateway \
  -c "select * from stripe_purchase order by created_at desc limit 5;"

# the browser test that holds the refusal promise
npm run dev -- --port 5177 && npm run e2e:purchase
```

See also `docs/card-payments-locally.md`, which covers stripe-mock vs a real
test key and the `STRIPE_API_BASE` safety rail.
