#!/usr/bin/env bash
#
# Repair a mint whose key material was lost to migration V3.
#
# `migrate-keys-to-hashi.sh` copies `t_key.private_key` into HashiCorp Vault
# and refuses once V3 has dropped that column — correctly, because by then the
# plaintext it would copy no longer exists in the database.
#
# But on a DEV stack it still exists somewhere else: `preload-test-data.json`,
# the file the mint seeds itself from, carries `privateKeyHex` for every key
# alongside the very ids the rows use. That is what this recovers from.
#
# Observed state this fixes, measured rather than assumed:
#
#   - t_key has no `private_key` column (V3 has run)
#   - every row has a `vault_path` and reads back `privateKey: null`
#   - VAULT_HASHI_ENABLED is false on the mint and on imani-vault-jpa
#   - `hashicorp-vault` does not resolve from the stack's network
#   - that vault has no `cashu` secrets mount
#
# Any one of those alone breaks signing, which is why the symptom is the
# unhelpful `PrivateKey.fromString: s is marked non-null but is null`.
#
# ## Why this is safe here and nowhere else
#
# It writes DEV key material from a file committed for that purpose. It is
# refused outright unless the preload ids match the database, so it cannot
# write one deployment's keys into another's vault. On a real deployment the
# preload file does not exist and there is no shortcut: restore a pre-V3
# backup and run the migration.
set -euo pipefail

VAULT_DB="${VAULT_DB:-mint-db-test}"
VAULT_DB_NAME="${VAULT_DB_NAME:-imani_vault}"
MINT="${MINT:-imani-mint-rest-test}"
HASHI="${HASHI:-cashu-mint-hashicorp-vault-1}"
HASHI_TOKEN="${HASHI_TOKEN:-dev-root-token}"
MOUNT="${MOUNT:-cashu}"
PRELOAD="${PRELOAD:-/app/config/preload-test-data.json}"

psql() { docker exec "$VAULT_DB" psql -U postgres -d "$VAULT_DB_NAME" "$@"; }
vault() { docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN="$HASHI_TOKEN" "$HASHI" vault "$@"; }

echo "Reading the preload file from $MINT…"
if ! docker exec "$MINT" test -f "$PRELOAD" 2>/dev/null; then
  echo "No preload file at $PRELOAD."
  echo "Without it there is nothing to recover from: restore imani-vault-db from"
  echo "a backup taken before V3 and run ./deploy/migrate-keys-to-hashi.sh."
  exit 1
fi
docker exec "$MINT" cat "$PRELOAD" > /tmp/imani-preload.json

MINT_ID=$(python3 -c "import json;print(json.load(open('/tmp/imani-preload.json'))['mintId'])")
KEYSET_ID=$(python3 -c "import json;print(json.load(open('/tmp/imani-preload.json'))['keySetId'])")

# The guard. Writing keys the database does not reference would leave the mint
# reading nulls from paths nothing wrote, which is the state we are leaving.
echo "Checking the preload matches this database…"
MATCHED=$(python3 - <<'PY'
import json, subprocess, os
d = json.load(open('/tmp/imani-preload.json'))
ids = [k['id'] for k in d['keys']]
q = "select count(*) from t_key where id in (%s);" % ','.join("'%s'" % i for i in ids)
out = subprocess.run(
    ['docker', 'exec', os.environ.get('VAULT_DB', 'mint-db-test'),
     'psql', '-U', 'postgres', '-d', os.environ.get('VAULT_DB_NAME', 'imani_vault'), '-tAc', q],
    capture_output=True, text=True).stdout.strip()
print(f"{out}/{len(ids)}")
PY
)
if [ "${MATCHED%%/*}" != "${MATCHED##*/}" ] || [ "${MATCHED%%/*}" = "0" ]; then
  echo "Refusing: the preload describes keys this database does not hold ($MATCHED matched)."
  echo "This preload belongs to a different mint, so writing it would not help."
  exit 1
fi
echo "  $MATCHED keys matched."

echo "Enabling the $MOUNT secrets engine (no-op if it exists)…"
vault secrets enable -path="$MOUNT" kv-v2 >/dev/null 2>&1 || true

echo "Writing key material…"
count=0
while IFS='|' read -r amount privkey; do
  [ -z "${amount:-}" ] && continue
  vault kv put -mount="$MOUNT" "keys/$MINT_ID/$KEYSET_ID/$amount" private_key="$privkey" >/dev/null
  count=$((count + 1))
done < <(python3 -c "
import json
d = json.load(open('/tmp/imani-preload.json'))
for k in d['keys']:
    print('%s|%s' % (k['amount'], k['privateKeyHex']))
")
rm -f /tmp/imani-preload.json
echo "  wrote $count keys."

cat <<EOF

Done. The material is in the vault; the mint still has to be told to read it:

  1. imani-vault-jpa and imani-mint-rest need VAULT_HASHI_ENABLED=true
  2. both need to REACH the vault. It runs on the cashu-mint stack's network,
     and this stack is on imani-test_imani-internal, so connect them:

       docker network connect imani-test_imani-internal $HASHI

  3. then restart:

       VAULT_HASHI_ENABLED=true ./deploy/up.sh

Verify with a mint quote, or simply:

  curl -s localhost:27777/v1/keys | head -c 120
EOF
