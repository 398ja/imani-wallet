#!/usr/bin/env bash
#
# Copy the mint's key material into HashiCorp Vault, then point the rows at it.
#
# Run this ONCE, BEFORE starting a locally built cashu-vault (0.11.1+). That
# build's Flyway migration V3 DROPS t_key.private_key and moves key material to
# an external secret store. Run it with an empty store and every key reads back
# null: the mint dies on PrivateKey.fromString with "s is marked non-null but is
# null", which names neither Vault nor the path it could not read.
#
# The store is already on the machine — the cashu-mint compose stack runs a
# dev-mode HashiCorp Vault — so this is a migration, not new infrastructure.
#
# Safe to re-run: writing the same secret twice is a no-op, and the UPDATE is
# idempotent. It refuses outright once private_key is gone, because by then the
# plaintext this needs to copy no longer exists anywhere.
set -euo pipefail

VAULT_DB="${VAULT_DB:-imani-vault-db-test}"
VAULT_DB_NAME="${VAULT_DB_NAME:-imani_vault}"
HASHI="${HASHI:-cashu-mint-hashicorp-vault-1}"
HASHI_TOKEN="${HASHI_TOKEN:-dev-root-token}"
# Must match vault.hashi.engine.mount, which defaults to `cashu`. Writing to the
# wrong mount succeeds and still reads back null.
MOUNT="${MOUNT:-cashu}"

psql() { docker exec "$VAULT_DB" psql -U postgres -d "$VAULT_DB_NAME" "$@"; }

if ! psql -tAc "select 1 from information_schema.columns
                where table_name='t_key' and column_name='private_key';" | grep -q 1; then
  echo "t_key has no private_key column: V3 has already run."
  echo "The plaintext keys are gone, so there is nothing left to copy. If the"
  echo "mint cannot read its keys, restore the database from before V3 and"
  echo "re-run this script BEFORE starting the new vault."
  exit 1
fi

echo "Copying keys into HashiCorp Vault (mount=$MOUNT)…"
count=0
while IFS='|' read -r amount privkey keyset mint; do
  [ -z "${amount:-}" ] && continue
  docker exec -e VAULT_TOKEN="$HASHI_TOKEN" "$HASHI" \
    vault kv put -mount="$MOUNT" "keys/$mint/$keyset/$amount" private_key="$privkey" >/dev/null
  count=$((count + 1))
done < <(psql -tAc "select k.amount, k.private_key, ks.key_set_id, ks.mint_id
                    from t_key k join t_keyset ks on ks.id = k.key_set_id
                    order by k.amount;")
echo "  $count keys written"

# The path format is HCKeyVault.buildPath(): keys/{mintId}/{keySetId}/{amount}.
# V3 backfills vault_path with '' (a NOT NULL column needs a default to be
# addable), so without this every lookup asks for the empty path.
echo "Pointing the rows at those paths…"
psql -c "update t_key k
         set vault_path = 'keys/' || ks.mint_id || '/' || ks.key_set_id || '/'
                          || trim(trailing '.' from to_char(k.amount, 'FM999999999999'))
         from t_keyset ks
         where ks.id = k.key_set_id;" | tail -1

echo
echo "Done. Now start the matched image set together:"
echo
echo "  VAULT_HASHI_ENABLED=true \\"
echo "    VAULT_JPA_IMAGE=imani-vault-jpa:libfix \\"
echo "    MINT_REST_IMAGE=imani-mint-rest:libfix \\"
echo "    GATEWAY_CUSTOMER_IMAGE=imani-gateway-customer:frameseq ./deploy/up.sh"
echo
echo "Note the MINT needs the vault.hashi.* settings too: it bundles"
echo "cashu-vault-hashi and resolves the secret itself."
