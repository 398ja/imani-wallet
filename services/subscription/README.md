# The subscription site (`subscription.imani.casa`, its own origin)

Where a stall buys a plan (#407, #411). It is a single-page site (`apps/subscription`) plus this
service, on its own origin. The site uses the wallet's stack and components: React, Vite, Tailwind,
react-router and `src/components/ui`.

- **Signing in: there is no login page.** The stall opens the site from its wallet (Settings ›
  Subscription › Upgrade my plan). That tap opens the site in a new tab, and the WALLET signs the
  site's NAP login over `postMessage` (NAP extension 0002, `src/lib/sisterSiteSigner.ts`): the key
  never reaches this origin, and the wallet signs only proofs addressed to this site. The service
  answers with an HttpOnly session cookie. **Every page needs that session**; opened any other way,
  the site says "Open this from your wallet".
- **Merchants only.** The session's role is read from the stall's own signed, live
  `imani:merchant` record (gateway-customer's public nostr query, `merchantRole.ts`). A customer
  key is refused at login and never holds a session; the role is re-read on every request, so a
  stall that retires its record loses access.
- **Buy** a tier by card through Stripe Checkout, using Billing for renewals and Tax for VAT.
- **The plans** are the ones www.imani.casa/pricing publishes: Starter (the catalog's `free`
  tier), Essentials (the `basic` tier) and Pro. `GET /v1/plans` lists Starter and every catalog tier that has a price in
  `SUBSCRIPTION_PRICES`, with the amount read from Stripe. A tier with no card price (Town / BID
  Partner, "Contact us") is never offered, even if the catalog defines it for hand grants. Every
  price is in **GBP**: a Stripe price in any other currency is neither listed nor sold.
- **On `invoice.paid`**, the service mints a licence through gateway-customer as the seller and DMs
  it to the stall. This happens once per invoice, and a replayed or retried event resumes rather
  than repeats.
- **Hand grants** (`/admin`, allowlisted pubkeys): any limits, any window, to any stall. Each one
  is recorded with who issued it and why.
- **`GET /v1/catalog`** serves the tier catalog signed by the seller key. The wallet adopts it, so
  limits change without an app release.

The service holds a **sales ledger** (`/data/ledger.json`) for renewals, re-sends and support.
Nothing reads it to *grant* a feature: the wallet verifies the licence it holds, offline (ADR 0007).

## Run

```bash
npx vite build --config apps/subscription/vite.config.ts           # the site
npx tsx --tsconfig tsconfig.services.json services/subscription/server.ts
npx tsx --tsconfig tsconfig.services.json e2e/subscription.e2e.ts   # two-origin browser e2e: builds the site, fakes Stripe + gateway
docker build -f services/subscription/Dockerfile -t imani-subscription .
```

## Environment

| Variable | |
| --- | --- |
| `SUBSCRIPTION_PUBLIC_ORIGIN` | the site's own origin, e.g. `https://subscription.imani.casa`; NAP login proofs are addressed to it and the session cookie is issued for it |
| `SUBSCRIPTION_BASE_PATH` | `''` (the root of its origin). A path only if the edge mounts it under one, matching the `SUBSCRIPTION_BASE` build arg |
| `VITE_WALLET_ORIGIN` (build arg, **required**) | the ONE wallet origin the site accepts a signer from, e.g. `https://wallet.imani.casa`. The wallet side is `VITE_SUBSCRIPTION_SITE_URL` (the wallet's `.env`/build arg), which must name this site |
| `VITE_RELAY_URL` (build arg, **required**) | the public `wss://` relay the header reads the stall's profile from, as the wallet does. The other half is the gateway cache at `/api/v1/nostr/query` on this origin, which the edge must route to gateway-customer |
| `VITE_LICENCE_SELLER_PUBKEY` (build arg, **required**) | the seller's public key, x-only hex: the only signer whose verification attestation (#418) puts a badge on the header's avatar. The public half of `IMANI_SUBSCRIPTIONS_SELLER_NSEC` |
| `SUBSCRIPTION_WALLET_URL` | gateway-customer (mint, deliver, revoke, and the public nostr query the merchant role is read from) |
| `EDGE_SECRET` | edge secret gateway-customer trusts |
| `IMANI_SUBSCRIPTIONS_SELLER_NSEC` | the seller (`GATEWAY_CUSTOMER_LICENCE_SELLER_PUBKEYS`); also signs the catalog; wallets pin it as `VITE_LICENCE_SELLER_PUBKEY` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | webhook events: `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted` |
| `SUBSCRIPTION_PRICES` | `basic:monthly=price_…,basic:annual=price_…,pro:monthly=price_…,pro:annual=price_…`. GBP prices only (Essentials £8/£70, Pro £25/£250, VAT inclusive; `deploy/subscription-local/stripe-prices.sh` creates them in test mode). A tier the catalog does not define, or `free`, is refused at boot |
| `SUBSCRIPTION_ADMIN_PUBKEYS` | hex pubkeys allowed to issue grants and revoke |
| `SUBSCRIPTION_AUTOMATIC_TAX` | `on` (default) or `off` |
| `SUBSCRIPTION_CATALOG_PATH`, `SUBSCRIPTION_LEDGER_PATH`, `SUBSCRIPTION_STATIC_DIR` | set in the image |
| `STRIPE_API_BASE` | tests and stripe-mock only |

Bump `version` in `catalog.json` whenever a number changes. Wallets ignore a catalog that is not
newer than the one they hold.

**The free tier's threshold is hard-coded in every merchant currency** (#506): about 100 USD,
rounded down to 2 significant figures (100 face in USD, EUR, GBP, CHF, CAD and AUD; 65,000 in XOF
and XAF). There is no exchange-rate table and no rate feed at runtime. The amounts live in
`packages/licence/src/freeTierAmounts.ts`, which the wallet's bundled catalog uses, and are copied
into `catalog.json`. The onboarding currency picker offers exactly these codes. Do not edit them by
hand. At the quarterly review, run `npx tsx scripts/free-tier-amounts.mts`, which rewrites both and
bumps the version if an amount changed. `src/lib/__tests__/freeTierCurrencies.test.ts` fails if
the two differ.
