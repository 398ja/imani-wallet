#!/usr/bin/env bash
# Bring up the imani-test stack for the cashback e2e probes, on staging images.
#
#   e2e/stack/up.sh                    # start or refresh everything the wallet needs
#   e2e/stack/up.sh logs gateway-portal  # any other compose subcommand
#
# Swap one service for a local build by exporting its image before calling, e.g.
#   GATEWAY_PORTAL_IMAGE=imani-gateway-portal:fix58 e2e/stack/up.sh
#
# It wraps deploy/up.sh's compose invocation and adds compose.cashback-e2e.yml as
# a third file. The image variables are EXPORTED here because .env.test sets
# them too, and a value in the shell environment wins over an --env-file.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WALLET="$(cd "$HERE/../.." && pwd)"
DEPLOY="${DEPLOY:-/home/eric/IdeaProjects/imani-deploy}"

export WALLET_DEPLOY_DIR="$WALLET/deploy"
export E2E_STACK_DIR="$HERE"
export GATEWAY_CORE_IMAGE="${GATEWAY_CORE_IMAGE:-docker.398ja.xyz/staging/gateway-core:latest}"
export GATEWAY_CUSTOMER_IMAGE="${GATEWAY_CUSTOMER_IMAGE:-docker.398ja.xyz/staging/gateway-customer:latest}"
export GATEWAY_PORTAL_IMAGE="${GATEWAY_PORTAL_IMAGE:-docker.398ja.xyz/staging/gateway-portal:latest}"
export CASHBACK_CLAIM_IMAGE="${CASHBACK_CLAIM_IMAGE:-docker.398ja.xyz/staging/imani-cashback-claim:latest}"
export MERCHANT_IMAGE="${MERCHANT_IMAGE:-docker.398ja.xyz/staging/imani-merchant:latest}"
export MINT_REST_IMAGE="${MINT_REST_IMAGE:-docker.398ja.xyz/staging/cashu-mint-rest:latest}"
export VAULT_JPA_IMAGE="${VAULT_JPA_IMAGE:-docker.398ja.xyz/staging/cashu-vault-jpa:latest}"
export PAYMENT_ADAPTER_IMAGE="${PAYMENT_ADAPTER_IMAGE:-docker.398ja.xyz/staging/payment-adapter-rest:latest}"
export PHOENIXD_MOCK_IMAGE="${PHOENIXD_MOCK_IMAGE:-docker.398ja.xyz/staging/phoenixd-mock:latest}"

compose() {
  local env_files=(--env-file "$DEPLOY/.env.test")
  [ -f "$DEPLOY/.env.local" ] && env_files+=(--env-file "$DEPLOY/.env.local")
  docker compose \
    -f "$DEPLOY/docker-compose.test.yml" \
    -f "$WALLET/deploy/compose.override.yml" \
    -f "$HERE/compose.cashback-e2e.yml" \
    "${env_files[@]}" -p imani-test "$@"
}

if [ $# -gt 0 ]; then
  MINT_HOST_IP="${MINT_HOST_IP:-$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' imani-mint-rest-test 2>/dev/null || echo 0.0.0.0)}" \
    compose "$@"
  exit
fi

# Mint first: three services need its container IP for the loopback-named alias.
MINT_HOST_IP=0.0.0.0 compose up -d hashicorp-vault
"$HERE/seed-hashi.sh" || true
MINT_HOST_IP=0.0.0.0 compose up -d imani-mint-rest
mint_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' imani-mint-rest-test)"
echo "mint is at $mint_ip"
export MINT_HOST_IP="$mint_ip" MINT_URL="${MINT_URL:-https://mint-tls:7443}"

compose up -d \
  imani-gateway-db bottin-db imani-vault-db imani-payment-db \
  bottin-api nostr-relay phoenixd-mock blossom \
  imani-vault-jpa payment-adapter imani-mint-rest \
  mint-tls claim-tls account-app gateway-core gateway-customer cashback-claim merchant-service
# --no-deps: gateway-customer's health reads OUT_OF_SERVICE when it works (see deploy/up.sh).
compose up -d --no-deps gateway-portal

# The seed merchant's stall lives on the relay; republish so probe-cashback.mts
# (which signs as .seed-keys.json imani-terminals) holds coupon:issue.
RELAY_URL=ws://localhost:27778 node "$WALLET/scripts/open-stall.mjs" >/dev/null 2>&1 || true
echo "stack up. First cashback after a mint restart may fail once (key read race); probes retry setup."
