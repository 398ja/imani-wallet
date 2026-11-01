#!/usr/bin/env bash
# Load the test mint's preload keyset private keys into the dev HashiCorp Vault
# at the exact paths imani-vault-db's t_key.vault_path names (KV v2, mount cashu).
# Dev vault is in-memory: re-run after every restart of hashicorp-vault-cashback-e2e.
set -euo pipefail
PRELOAD="${PRELOAD:-/home/eric/IdeaProjects/imani-deploy/config/test/preload-test-data.json}"
H=hashicorp-vault-cashback-e2e
v() { docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=dev-root-token "$H" vault "$@"; }
v secrets list | grep -q '^cashu/' || v secrets enable -path=cashu kv-v2 >/dev/null
declare -A path
while IFS='|' read -r amount p; do path[$amount]="$p"; done < <(
  docker exec imani-vault-db-test psql -U postgres -d imani_vault -tAc "select amount, vault_path from t_key")
n=0
while IFS=' ' read -r amount priv; do
  p="${path[$amount]:-}"; [ -z "$p" ] && continue
  v kv put -mount=cashu "${p#cashu/}" private_key="$priv" >/dev/null
  v kv put -mount=cashu "$p" private_key="$priv" >/dev/null
  n=$((n+1))
done < <(python3 -c "import json;[print(k['amount'],k['privateKeyHex']) for k in json.load(open('$PRELOAD'))['keys']]")
echo "seeded $n keys"
