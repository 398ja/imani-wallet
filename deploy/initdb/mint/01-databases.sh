#!/bin/sh
# Local mint-db first-boot init: as prod/demo (imani-deploy initdb/mint), the mint's data
# kept on its own server. Locally the mint runs without its own ledger database
# (CASHU_MINT_JPA_ENABLED is off), so only the vault's is used; cashu_mint is created so
# turning that on needs no new server. Local stack only: each password is the role name.
set -eu

create() {
  role=$1 db=$2
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
       -v role="$role" -v db="$db" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'role';
CREATE DATABASE :"db" OWNER :"role";
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
SQL
  echo "mint-db init: database $db owned by $role"
}

create vault imani_vault
create mint  cashu_mint
# cashu-mint migration V20260601_003 creates a read-only Grafana role (see prod init).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c 'ALTER ROLE mint CREATEROLE;'
