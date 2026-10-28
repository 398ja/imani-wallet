#!/usr/bin/env bash
# Bring up subscription.imani.casa locally. Secrets come from imani-deploy/.env.staging and are
# written to a gitignored .env here; nothing is committed.
set -euo pipefail
cd "$(dirname "$0")"
STAGING_ENV=${STAGING_ENV:-../../../imani-deploy/.env.staging}
get() { grep -E "^$1=" "$STAGING_ENV" | head -1 | cut -d= -f2- | tr -d "\"'"; }

export STRIPE_SECRET_KEY=$(get STRIPE_SECRET_KEY)
case "$STRIPE_SECRET_KEY" in sk_test_*) ;; *) echo "refusing: STRIPE_SECRET_KEY is not a test key" >&2; exit 1 ;; esac

# The webhook secret the Stripe CLI signs forwarded events with (stable per account and device).
WHSEC=$(docker run --rm stripe/stripe-cli:latest listen --api-key "$STRIPE_SECRET_KEY" --print-secret 2>/dev/null | tail -1)
PRICES=$(./stripe-prices.sh | sed 's/^SUBSCRIPTION_PRICES=//')
ADMINS=${SUBSCRIPTION_ADMIN_PUBKEYS:-}

umask 077
cat > .env <<EOF
STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET=$WHSEC
SUBSCRIPTION_PRICES=$PRICES
SUBSCRIPTION_ADMIN_PUBKEYS=$ADMINS
SUBSCRIPTION_WALLET_URL=https://wallet.staging.398ja.xyz
IMANI_SUBSCRIPTIONS_SELLER_NSEC=$(get IMANI_SUBSCRIPTIONS_SELLER_NSEC)
EDGE_SECRET=${EDGE_SECRET:-unused-against-staging}
INTERNAL_RELAY_URL=ws://nostr-relay:7777
# Off locally: Stripe Tax needs a head office address on the account (Settings > Tax), which the
# shared test account does not have. Set SUBSCRIPTION_AUTOMATIC_TAX=on once it does.
SUBSCRIPTION_AUTOMATIC_TAX=${SUBSCRIPTION_AUTOMATIC_TAX:-off}
EOF

docker compose up -d --build
for i in $(seq 1 30); do curl -sf http://localhost:18910/health >/dev/null && break; sleep 1; done
curl -sf http://localhost:18910/health >/dev/null || { docker compose logs --tail=40; exit 1; }
echo
echo "subscription site + service are up on http://localhost:18910 (their own origin, #411)"
echo "  There is no login page: the site is opened FROM a wallet, which signs it in."
echo "  Wallet dev server: VITE_SUBSCRIPTION_SITE_URL=http://localhost:18910 npm run dev, then"
echo "  Settings > Subscription > Upgrade my plan (rebuild here with VITE_WALLET_ORIGIN=http://localhost:5173)."
echo "  Or run e2e/subscription-local.e2e.ts, which brings its own stand-in wallet."
echo "  Stripe: test mode, webhooks forwarded by the 'stripe' container"
echo "  Pay with card 4242 4242 4242 4242, any future date, any CVC"
echo "  Licences are delivered by staging to the stall's wallet on wallet.staging.398ja.xyz"
[ -n "$ADMINS" ] || echo "  Admin page: set SUBSCRIPTION_ADMIN_PUBKEYS=<hex> and re-run to enable /admin"
echo "  Logs: docker compose -f $(pwd)/docker-compose.yml logs -f"
