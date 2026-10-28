# subscription.imani.casa, running locally

This runs the site and service on your machine against **Stripe test mode** and the **staging**
gateway. Purchases are real test-mode Checkout sessions, and the resulting plan is delivered to
the stall's wallet on wallet.staging.398ja.xyz.

```bash
./up.sh                                           # build, configure, start
SUBSCRIPTION_ADMIN_PUBKEYS=<hex> ./up.sh          # same, with /admin enabled for that key
open http://localhost:18910
docker compose logs -f                            # service + forwarded Stripe events
docker compose down                               # stop (add -v to forget the ledger)
```

`up.sh` reads `STRIPE_SECRET_KEY` (test keys only, others are refused) and
`IMANI_SUBSCRIPTIONS_SELLER_NSEC` from `../../../imani-deploy/.env.staging`. It writes a
gitignored `.env`, then:
- creates the Imani Basic and Pro prices in the test account if they are missing (`stripe-prices.sh`,
  idempotent by lookup key);
- starts the `stripe` container, which forwards the account's webhooks to the service.

## Testing it by hand

There is no login page (#411). The site is opened from a wallet, which signs it in.

1. **Run a wallet** pointed at this site: `VITE_SUBSCRIPTION_SITE_URL=http://localhost:18910 npm run dev`
   in the repo root, and rebuild this container for that wallet:
   `VITE_WALLET_ORIGIN=http://localhost:5173 ./up.sh`.
2. **Open the site from the wallet**: log in to the wallet as a stall from staging, go to Settings ›
   Subscription, tap **Upgrade my plan**. The site opens in a new tab, already signed in. A key
   without a stall record is refused ("Plans are for stalls").
3. **Choose** Basic or Pro and pay with card `4242 4242 4242 4242`, any future date, any CVC.
4. **Wait** about 10 seconds. The plan arrives in that stall's wallet on staging (Settings ›
   Subscription), and on `/account` here.
5. **Cancel or change the card** from `/account` → "Card, invoices and cancellation" (the Stripe
   portal).
6. **Admin**: if you started with `SUBSCRIPTION_ADMIN_PUBKEYS`, open `/admin` to grant limits
   (e.g. 200 GBP for 30 days) to any stall.

Automated: `npx tsx --tsconfig tsconfig.services.json e2e/subscription-local.e2e.ts` runs steps
2 to 5 with a fresh stall (it publishes the stall record to staging and brings its own stand-in
wallet on `127.0.0.1:18924`, the default `VITE_WALLET_ORIGIN`), and checks the delivered licence
with the wallet's own code.

## Known local differences

- **Stripe Tax is off** (`SUBSCRIPTION_AUTOMATIC_TAX=off`). The test account has no head office
  address, and Stripe refuses tax calculation without one. Add the address in the Stripe dashboard
  (Settings › Tax), then run `SUBSCRIPTION_AUTOMATIC_TAX=on ./up.sh`.
- **Wallet catalog**: the wallet on staging is built from `main`, so it does not yet show the tier
  limits or fetch this catalog. The licence still arrives and verifies.
