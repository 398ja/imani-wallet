#!/bin/sh
# Local app-db first-boot init: the SAME layout as prod/demo (imani-deploy initdb/app),
# one Postgres server, one database and one login role per service, so the local stack
# exercises the real wiring. Local stack only, so every role's password is its name.
# Runs only when the app-db volume is empty (`docker volume rm imani-test_app-db-data`).
set -eu

create() {
  role=$1 db=$2
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
       -v role="$role" -v db="$db" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'role';
CREATE DATABASE :"db" OWNER :"role";
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
SQL
  echo "app-db init: database $db owned by $role"
}

create core     imani_core
create customer imani_customer
create portal   imani_portal
create merchant imani_merchant
create payment  payment_gateway
create bottin   bottin
# Local-only: the cashback-claim service (not in prod's app-db yet).
create cashback imani_cashback_claim
