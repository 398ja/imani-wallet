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
echo
echo "Stack is ready."
