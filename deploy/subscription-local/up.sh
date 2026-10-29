#!/usr/bin/env bash
# Bring up subscription.imani.casa locally, against REAL Stripe test mode. Secrets come from
# imani-deploy/.env.staging and are written to a gitignored .env here; nothing is committed.
#
#   ./up.sh                 # gateway: STAGING (wallet.staging.398ja.xyz). e2e/subscription-local.e2e.ts
#   GATEWAY=local ./up.sh   # gateway: the LOCAL stack (deploy/up.sh), wallet dev server on :5173
#
# GATEWAY=local is the whole local deployment: the wallet you run with `npm run dev` (its .env.local
# names this site, VITE_SUBSCRIPTION_SITE_URL=http://localhost:18910) opens the site, signs it in,
# and the plan bought here is minted and delivered by the local gateway-customer to that wallet.
set -euo pipefail
cd "$(dirname "$0")"
STAGING_ENV=${STAGING_ENV:-../../../imani-deploy/.env.staging}
GATEWAY=${GATEWAY:-staging}
get() { grep -E "^$1=" "$STAGING_ENV" | head -1 | cut -d= -f2- | tr -d "\"'"; }
export STRIPE_SECRET_KEY=$(get STRIPE_SECRET_KEY)
case "$STRIPE_SECRET_KEY" in sk_test_*) ;; *) echo "refusing: STRIPE_SECRET_KEY is not a test key" >&2; exit 1 ;; esac
# The webhook secret the Stripe CLI signs forwarded events with (stable per account and device).
WHSEC=$(docker run --rm stripe/stripe-cli:latest listen --api-key "$STRIPE_SECRET_KEY" --print-secret 2>/dev/null | tail -1)
PRICES=$(./stripe-prices.sh | sed 's/^SUBSCRIPTION_PRICES=//')
ADMINS=${SUBSCRIPTION_ADMIN_PUBKEYS:-}

case "$GATEWAY" in
  staging)
    WALLET_URL=https://wallet.staging.398ja.xyz
    WALLET_PUBLIC_URL=
    EDGE=${EDGE_SECRET:-unused-against-staging}
    export VITE_WALLET_ORIGIN=${VITE_WALLET_ORIGIN:-http://127.0.0.1:18924}
    ;;
  local)
    # The local stack's gateway-customer, by name on its network. It binds NIP-98 `u` to the wallet
    # dev origin (GATEWAY_SECURITY_NIP98_PUBLIC_BASE_URL, deploy/compose.override.yml), so the
    # service signs for that and sends to the container. The edge secret is the stack's dev one.
    if ! docker inspect gateway-customer-test >/dev/null 2>&1; then
      echo "GATEWAY=local needs the local stack: ../up.sh (and npm run dev for the wallet)" >&2
      exit 1
    fi
    if ! docker exec gateway-customer-test env | grep -q '^GATEWAY_CUSTOMER_LICENCE_SELLER_PUBKEYS=.'; then
      echo "the local gateway-customer does not name the licence seller yet: re-run ../up.sh" >&2
      exit 1
    fi
    WALLET_URL=http://gateway-customer:8082
    WALLET_PUBLIC_URL=${WALLET_DEV_ORIGIN:-http://localhost:5173}
    EDGE=dev-edge-secret-local-only-32-plus-chars
    export VITE_WALLET_ORIGIN=${VITE_WALLET_ORIGIN:-$WALLET_PUBLIC_URL}
    ;;
  *) echo "GATEWAY must be staging or local" >&2; exit 1 ;;
esac
# The compose file joins the local stack's network; give it one when that stack is not running.
docker network inspect imani-test_imani-internal >/dev/null 2>&1 || docker network create imani-test_imani-internal >/dev/null

umask 077
cat > .env <<EOF
STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET=$WHSEC
SUBSCRIPTION_PRICES=$PRICES
SUBSCRIPTION_ADMIN_PUBKEYS=$ADMINS
SUBSCRIPTION_WALLET_URL=$WALLET_URL
SUBSCRIPTION_WALLET_PUBLIC_URL=$WALLET_PUBLIC_URL
IMANI_SUBSCRIPTIONS_SELLER_NSEC=$(get IMANI_SUBSCRIPTIONS_SELLER_NSEC)
EDGE_SECRET=$EDGE
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
echo "  gateway: $GATEWAY ($WALLET_URL); accepts a signer from $VITE_WALLET_ORIGIN only"
echo "  There is no login page: the site is opened FROM a wallet, which signs it in."
if [ "$GATEWAY" = local ]; then
  echo "  Wallet: npm run dev (its .env.local sets VITE_SUBSCRIPTION_SITE_URL=http://localhost:18910),"
  echo "  then as a stall: Settings > Subscription > Upgrade my plan."
  echo "  Plans are minted and delivered by the LOCAL gateway to that wallet."
else
  echo "  Run e2e/subscription-local.e2e.ts, which brings its own stand-in wallet."
  echo "  Licences are delivered by staging to the stall's wallet on wallet.staging.398ja.xyz"
fi
echo "  Stripe: test mode, webhooks forwarded by the 'stripe' container"
echo "  Pay with card 4242 4242 4242 4242, any future date, any CVC"
[ -n "$ADMINS" ] || echo "  Admin page: set SUBSCRIPTION_ADMIN_PUBKEYS=<hex> and re-run to enable /admin"
echo "  Logs: docker compose -f $(pwd)/docker-compose.yml logs -f"
