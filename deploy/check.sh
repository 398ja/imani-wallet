#!/usr/bin/env bash
# Is the local stack actually up?
#
#   ./deploy/check.sh
#
# `docker ps` alone will not tell you: a container that exited is simply absent
# from the list, so counting running containers reports a healthy stack when a
# service never started. That is how account-app sat dead through a whole
# evening of load runs without anyone noticing.
#
# Every service up.sh starts is named here explicitly, so a missing one is a
# failure rather than a shorter list.
set -uo pipefail

SERVICES=(
  imani-gateway-db bottin-db imani-vault-db imani-payment-db
  bottin-api nostr-relay phoenixd-mock blossom
  imani-vault-jpa payment-adapter imani-mint-rest
  gateway-core gateway-customer gateway-portal
)

fail=0
for service in "${SERVICES[@]}"; do
  name=$(docker ps --format '{{.Names}}' | grep -E "^${service}(-test)?$" | head -1)
  if [ -z "$name" ]; then
    printf '  %-20s NOT RUNNING\n' "$service"
    fail=1
    continue
  fi
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}up{{end}}' "$name")

  # gateway-customer's actuator answers OUT_OF_SERVICE while serving requests
  # perfectly (§15.5 of the design spec, and the note in up.sh). Its own
  # healthcheck greps for UP, so docker marks it unhealthy forever. Reaching
  # past the healthcheck to the thing that matters: does it answer?
  # `starting` counts too, not just `unhealthy`: this healthcheck greps for UP
  # and the actuator never says UP, so the container stays in `starting` until
  # its retries run out and then flips to `unhealthy`. Either way it is serving.
  if [ "$service" = gateway-customer ] && { [ "$health" = unhealthy ] || [ "$health" = starting ]; }; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      -X POST http://localhost:28082/api/v1/nostr/query \
      -H 'content-type: application/json' -d '{"kinds":[1059],"limit":1}')
    if [ "$code" = "200" ]; then
      printf '  %-20s serving (healthcheck says OUT_OF_SERVICE; known, see up.sh)\n' "$service"
      continue
    fi
  fi

  # gateway-portal's actuator answers 500 while the portal serves issuance
  # perfectly — verified by issuing a coupon through it while docker called it
  # unhealthy. Same class of false alarm as gateway-customer above, so ask the
  # same question: does it answer a real request?
  if [ "$service" = gateway-portal ] && { [ "$health" = unhealthy ] || [ "$health" = starting ]; }; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      -X POST http://localhost:28084/api/v1/portal/vouchers \
      -H 'content-type: application/json' -d '{}')
    # 400 means it validated the empty body, so the endpoint is live.
    if [ "$code" = "400" ] || [ "$code" = "401" ] || [ "$code" = "403" ]; then
      printf '  %-20s serving (actuator says unhealthy; known)\n' "$service"
      continue
    fi
  fi

  printf '  %-20s %s\n' "$service" "$health"
  case "$health" in
    unhealthy|starting) fail=1 ;;
  esac
done

# account-app publishes no port, so it can only be checked by whether it is up.
account=$(docker ps --filter name=account-app --format '{{.Status}}' | head -1)
if [ -z "$account" ]; then
  printf '  %-20s NOT RUNNING\n' account-app
  fail=1
else
  printf '  %-20s %s\n' account-app "$account"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "Stack is NOT ready. Try ./deploy/up.sh, then check logs for whatever is missing."
  exit 1
fi

# Healthy containers are not the same as a stack that can issue.
#
# The gateway keeps its cashu wallet in an H2 file, and a run that dies
# mid-swap leaves proofs in it that the mint has already spent. Every later
# issuance then fails with "Proof already used" (11001) while every container
# still reports healthy — so check.sh would say ready and the next recording
# would waste an hour before failing.
#
# Looks only at recent logs, so an old failure that has already been cleared
# does not keep raising the alarm.
# grep -c, not grep -q, and the count compared afterwards.
#
# Under `set -o pipefail`, `grep -q` exits as soon as it matches, docker gets
# SIGPIPE, and the PIPELINE reports 141 — so the `if` takes the false branch on
# the very runs where the string WAS found. The check silently never fired.
# Scoped to the CURRENT container lifetime, not a fixed window.
#
# Clearing the wallet means restarting the gateway, so errors from before that
# restart are exactly the ones already fixed. A time window keeps reporting
# them and check.sh cries wolf on a stack that is fine.
gateway_started=$(docker inspect -f '{{.State.StartedAt}}' gateway-customer-test 2>/dev/null || true)
spent_proofs=$(docker logs --since "${gateway_started:-10m}" gateway-customer-test 2>&1 |
  grep -c "mint_error_code=11001" || true)
if [ "${spent_proofs:-0}" -gt 0 ]; then
  echo
  echo "Stack is up but the gateway's wallet holds SPENT proofs ($spent_proofs recent 11001 errors)."
  echo "A recording that died mid-swap leaves these behind; issuance will keep failing."
  echo
  echo "  docker exec gateway-customer-test sh -c 'rm -f /root/.imani-bridge/wallet.mv.db /root/.imani-bridge/wallet.trace.db'"
  echo "  docker restart gateway-customer-test"
  echo
  exit 1
fi

echo
echo "Stack is ready."
