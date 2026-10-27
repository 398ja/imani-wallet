#!/usr/bin/env bash
# Create (once) the Imani plan prices in a Stripe TEST account and print SUBSCRIPTION_PRICES.
# Idempotent: prices are found by lookup_key and only created if missing.
set -euo pipefail
: "${STRIPE_SECRET_KEY:?set STRIPE_SECRET_KEY (sk_test_...)}"
case "$STRIPE_SECRET_KEY" in sk_test_*) ;; *) echo "refusing: not a test key" >&2; exit 1 ;; esac
API=https://api.stripe.com/v1
auth=(-u "$STRIPE_SECRET_KEY:")

product() { # name -> id
  local id
  id=$(curl -s "${auth[@]}" "$API/products/search" --data-urlencode "query=metadata['imani_tier']:'$2'" -G | sed -n 's/.*"id": "\(prod_[^"]*\)".*/\1/p' | head -1)
  [ -n "$id" ] || id=$(curl -s "${auth[@]}" "$API/products" -d name="$1" -d "metadata[imani_tier]=$2" | sed -n 's/.*"id": "\(prod_[^"]*\)".*/\1/p' | head -1)
  echo "$id"
}
price() { # product tier term amount interval -> id
  local key="imani_$2_$3" id
  id=$(curl -s "${auth[@]}" -G "$API/prices" -d "lookup_keys[]=$key" | sed -n 's/.*"id": "\(price_[^"]*\)".*/\1/p' | head -1)
  [ -n "$id" ] || id=$(curl -s "${auth[@]}" "$API/prices" -d product="$1" -d currency=gbp -d unit_amount="$4" \
    -d "recurring[interval]=$5" -d lookup_key="$key" -d tax_behavior=inclusive | sed -n 's/.*"id": "\(price_[^"]*\)".*/\1/p' | head -1)
  echo "$id"
}
basic=$(product "Imani Basic" basic); pro=$(product "Imani Pro" pro)
echo "SUBSCRIPTION_PRICES=basic:monthly=$(price "$basic" basic monthly 900 month),basic:annual=$(price "$basic" basic annual 9000 year),pro:monthly=$(price "$pro" pro monthly 2900 month),pro:annual=$(price "$pro" pro annual 29000 year)"
