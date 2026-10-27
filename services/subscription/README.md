# The subscription site (`/subscription` on the wallet's origin)

Where a stall buys a plan (#407). It is a single-page site (`apps/subscription`) plus this service,
mounted at `/subscription` on the WALLET's origin (the wallet's "Upgrade my plan" button opens it in
the same tab). The site uses the wallet's stack and components: React, Vite, Tailwind,
react-router and `src/components/ui`.

- **Sign in** with the stall's wallet key, opened with the wallet passphrase. The site finds it in
  this origin's localStorage (where the wallet keeps it), or else in the stall's Google Drive
  backup or an uploaded backup file. There is no extension, bunker or paste-your-nsec path. The
  decrypted key stays in the tab's memory. Every API call is NIP-98 signed, so there is no account.
- **Buy** a tier by card through Stripe Checkout, using Billing for renewals and Tax for VAT.
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
npx tsx e2e/subscription.e2e.ts                                     # browser e2e, fakes Stripe + gateway
docker build -f services/subscription/Dockerfile -t imani-subscription .
```

## Environment

| Variable | |
| --- | --- |
| `SUBSCRIPTION_PUBLIC_ORIGIN` | the wallet's origin, e.g. `https://wallet.imani.casa`; NIP-98 `u` tags must match it |
| `SUBSCRIPTION_BASE_PATH` | `/subscription`: the path the edge proxies here (left on, so routes see it stripped) |
| `VITE_GOOGLE_CLIENT_ID` (build arg) | the wallet's Google OAuth client, for the Drive backup sign-in |
| `SUBSCRIPTION_WALLET_URL` | gateway-customer (mint, deliver, revoke) |
| `EDGE_SECRET` | edge secret gateway-customer trusts |
| `IMANI_SUBSCRIPTIONS_SELLER_NSEC` | the seller (`GATEWAY_CUSTOMER_LICENCE_SELLER_PUBKEYS`); also signs the catalog; wallets pin it as `VITE_LICENCE_SELLER_PUBKEY` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | webhook events: `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted` |
| `SUBSCRIPTION_PRICES` | `basic:monthly=price_…,basic:annual=price_…,pro:monthly=price_…,pro:annual=price_…` |
| `SUBSCRIPTION_ADMIN_PUBKEYS` | hex pubkeys allowed to issue grants and revoke |
| `SUBSCRIPTION_AUTOMATIC_TAX` | `on` (default) or `off` |
| `SUBSCRIPTION_CATALOG_PATH`, `SUBSCRIPTION_LEDGER_PATH`, `SUBSCRIPTION_STATIC_DIR` | set in the image |
| `STRIPE_API_BASE` | tests and stripe-mock only |

Bump `version` in `catalog.json` whenever a number changes. Wallets ignore a catalog that is not
newer than the one they hold.
