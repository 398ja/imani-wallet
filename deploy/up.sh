#!/usr/bin/env bash
# Bring up the minimum imani backend the customer coupon wallet needs.
#
# Skipped on purpose: merchant-service (a merchant surface we
# do not use) and edge-proxy (Vite proxies straight
# to the host ports instead). gateway-portal IS needed — it is the merchant tier
# that issues coupons; phoenixd-mock IS needed — the mint backs vouchers with
# Lightning invoices. Both had to be image-corrected; see compose.override.yml.
#
#   ./deploy/up.sh              # start the wallet subset
#   ./deploy/up.sh ps           # any other compose subcommand
set -euo pipefail

DEPLOY="${DEPLOY:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../imani-deploy" && pwd)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICES=(
  imani-gateway-db bottin-db imani-vault-db imani-payment-db
  bottin-web nostr-relay phoenixd-mock blossom
  imani-vault-jpa payment-adapter imani-mint-rest
  account-app customer-wallet gateway-portal
)

export WALLET_DEPLOY_DIR="$HERE"

# Two services run images built from local source rather than pulled (see the
# `image:` comments in compose.override.yml). Nothing in the compose file builds
# them, and `docker compose up` on a missing local tag fails with "pull access
# denied … repository does not exist" — which reads as a registry problem and is
# not one. Check here instead, and print the command that fixes it.
require_local_image() {
    local image="$1" repo="$2" module="$3"
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        cat >&2 <<EOF
missing local image: $image

It is built from source, not pulled — the registry copy of this service predates
the coupon permission model (design spec §16). Build it with:

  cd $(cd "$HERE/../.." && pwd)/$repo
  mvn -pl $module package jib:dockerBuild -DskipTests -Djib.to.image=$image

EOF
        exit 1
    fi
}

require_local_image imani-gateway-core:acl-local   imani-gateway-core   gateway-core-rest
require_local_image imani-gateway-portal:acl-local imani-gateway-portal gateway-portal-rest

compose() {
  docker compose \
    -f "$DEPLOY/docker-compose.test.yml" \
    -f "$HERE/compose.override.yml" \
    --env-file "$DEPLOY/.env.test" \
    -p imani-test "$@"
}

if [ $# -eq 0 ]; then
  # gateway-portal is started separately, with --no-deps, because it
  # `depends_on: customer-wallet: service_healthy` and customer-wallet's
  # healthcheck reports OUT_OF_SERVICE even when it is working perfectly (§15.5
  # of the design spec). Compose believes it, refuses to start the portal, and
  # exits 1 — so a plain `./deploy/up.sh` brought up eleven services, silently
  # skipped the merchant tier, and reported failure for a stack that was fine.
  #
  # --no-deps only skips the dependency START, not the dependency: customer-wallet
  # is in SERVICES above and is already up by this line.
  everything_else=()
  for service in "${SERVICES[@]}"; do
    [ "$service" = gateway-portal ] || everything_else+=("$service")
  done

  compose up -d "${everything_else[@]}"
  compose up -d --no-deps gateway-portal
else
  compose "$@"
fi
