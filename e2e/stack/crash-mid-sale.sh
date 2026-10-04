#!/usr/bin/env bash
# Reproduce imani-gateway-customer#168 on the local imani-test stack:
# start a Sell, SIGKILL gateway-customer right after the voucher swap, restart it,
# wait past the recovery grace, and check the customer's relay inbox.
#
#   IMAGE=imani-gateway-customer:<tag> OUT=<dir> e2e/stack/crash-mid-sale.sh
#
# STACK_UP defaults to e2e/stack/up.sh in this checkout (DEPLOY points that at imani-deploy).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WALLET="$(cd "$HERE/../.." && pwd)"
# The stack launcher next to this script, unless STACK_UP names another checkout's.
STACK_UP="${STACK_UP:-$HERE/up.sh}"
[ -x "$STACK_UP" ] || { echo "STACK_UP is not an executable stack launcher: $STACK_UP" >&2; exit 2; }
OUT="${OUT:?set OUT to an output directory}"
IMAGE="${IMAGE:?set IMAGE to the gateway-customer image}"
WAIT_AFTER_RESTART="${WAIT_AFTER_RESTART:-480}"
mkdir -p "$OUT"

swap_in() {
  GATEWAY_CUSTOMER_IMAGE="$IMAGE" MINT_URL=https://mint-tls:7443 "$STACK_UP" up -d --no-deps gateway-customer \
    >"$OUT/up.log" 2>&1
  for _ in $(seq 1 90); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' gateway-customer-test 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  echo "gateway-customer did not become healthy" >&2
  return 1
}

echo "== swapping in $IMAGE"
swap_in || exit 1
docker inspect -f '{{.Config.Image}}' gateway-customer-test

since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "== selling"
(cd "$WALLET" && npx tsx e2e/probe-crash-mid-sale.mts sell >"$OUT/sale.json" 2>"$OUT/sell.log") &
sell_pid=$!

# The ISSUED write follows the swap's answer by a few milliseconds, and a kill
# driven from `docker logs -f` lands hundreds of milliseconds later. To crash
# in the issue's exact state (swap done at the mint, row still PENDING, no
# token stored) the sale's row is locked as soon as the voucher exists: the
# gateway's ISSUED write then waits on the lock, the swap marker is logged, the
# gateway is SIGKILLed, and only then is the lock released.
for _ in $(seq 1 100); do
  voucher="$(jq -r '.voucherId // empty' "$OUT/sale.json" 2>/dev/null)"
  [ -n "$voucher" ] && break
  sleep 0.05
done
docker exec imani-gateway-db-test psql -U postgres -d imani_customer -q -c \
  "BEGIN; SELECT voucher_id FROM pending_voucher WHERE voucher_id = '$voucher' FOR UPDATE; SELECT pg_sleep(300); COMMIT;" \
  >"$OUT/row-lock.log" 2>&1 &
lock_pid=$!

killed=no
# Follow the log and stop the gateway on the first match: the swap's answer and
# the ISSUED write are milliseconds apart, so a polling loop would be too late.
# `docker pause` freezes the process at once; the SIGKILL then lands on a
# process that has not run another instruction. pipefail is off for this one
# pipeline because grep closing it early is the success case.
set +o pipefail
timeout 300 docker logs -f --since "$since" gateway-customer-test 2>&1 \
  | grep -m1 'swap_with_custom_secret_success' >"$OUT/marker.txt"
set -o pipefail
if [ -s "$OUT/marker.txt" ]; then
  docker pause gateway-customer-test >/dev/null
  killed="$(date -u +%H:%M:%S.%N)"
  docker kill gateway-customer-test >/dev/null 2>&1 \
    || { docker unpause gateway-customer-test >/dev/null && docker kill gateway-customer-test >/dev/null; }
fi
echo "== SIGKILL at $killed"
docker exec imani-gateway-db-test psql -U postgres -d imani_customer -Atq -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(300)%' AND pid <> pg_backend_pid()" \
  >/dev/null
wait "$lock_pid" 2>/dev/null
docker logs --since "$since" gateway-customer-test >"$OUT/gateway-before-kill.log" 2>&1
[ "$killed" = no ] && { echo "never saw the swap"; wait "$sell_pid"; exit 1; }

docker exec imani-gateway-db-test psql -U postgres -d imani_customer -Atc \
  "select voucher_id, state, issued_at from pending_voucher where voucher_id = '$(jq -r .voucherId "$OUT/sale.json")'" \
  >"$OUT/row-after-kill.txt" 2>&1

echo "== restarting"
restart="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker start gateway-customer-test >/dev/null
wait "$sell_pid"
echo "== waiting ${WAIT_AFTER_RESTART}s for recovery (5 min grace) and delivery"
sleep "$WAIT_AFTER_RESTART"

docker logs --since "$restart" gateway-customer-test >"$OUT/gateway-after-restart.log" 2>&1
docker exec imani-gateway-db-test psql -U postgres -d imani_customer -Atc \
  "select * from pending_voucher where voucher_id = '$(jq -r .voucherId "$OUT/sale.json")'" \
  >"$OUT/row-final.txt" 2>&1 || true
(cd "$WALLET" && npx tsx e2e/probe-crash-mid-sale.mts check "$OUT/sale.json") | tee "$OUT/check.txt"
