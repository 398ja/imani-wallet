#!/usr/bin/env bash
#
# Register and verify the NIP-05 domain in bottin, so the wallet can claim
# handles through POST /api/v1/nip05.
#
# A fresh stack has NO domain row at all, and the failure is two-staged and
# misleading if you meet it from the app:
#
#   1. claiming any handle  -> 404 DOMAIN_NOT_FOUND  ("Domain not found: imani.local")
#   2. after registering it -> 412 DOMAIN_NOT_VERIFIED
#
# Neither is a wallet bug, and the first reads like a broken endpoint rather
# than missing fixture data.
#
# The verification step is a direct UPDATE rather than an API call on purpose.
# Bottin verifies a domain by DNS TXT record or a .well-known file
# (VerificationMethod.DNS_TXT / WELL_KNOWN_FILE), and `imani.local` is not a
# real domain — neither method can ever pass here. There is no config flag to
# skip it. So for the test stack we set the bit the verifier would have set.
#
# ponytail: writes straight to bottin's DB. Fine for a throwaway dev stack,
# wrong anywhere else — a real deployment verifies a real domain.
set -euo pipefail

DOMAIN="${BOTTIN_DEFAULT_DOMAIN:-imani.local}"
BOTTIN="${BOTTIN_URL:-http://localhost:28086}"
AUTH="${BOTTIN_ADMIN_USERNAME:-imani}:${BOTTIN_ADMIN_PASSWORD:-test-bottin-admin-9ace19b7fb61b5007225f745}"
# Owner is the demo merchant; bottin only stores it, nothing in the wallet reads it.
OWNER="${DOMAIN_OWNER_PUBKEY:-7952939535a79edc46d86e103785cee6f8119e8533787de8352257b051548448}"

# 201 on first run. Re-running gives 400 INVALID_ARGUMENT "Domain already
# exists" — not the 409 the endpoint documents for a duplicate — so neither code
# is treated as failure here.
status=$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X POST "$BOTTIN/api/v1/domains" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$DOMAIN\",\"ownerPubkey\":\"$OWNER\"}")
echo "register $DOMAIN: HTTP $status"

docker exec bottin-db-test psql -U bottin -d bottin -q -c \
  "UPDATE domains SET verified = true, verified_at = NOW(), verification_method = 'DNS_TXT' WHERE name = '$DOMAIN';"

echo -n "verified: "
docker exec bottin-db-test psql -U bottin -d bottin -tAc \
  "SELECT verified FROM domains WHERE name = '$DOMAIN';"
