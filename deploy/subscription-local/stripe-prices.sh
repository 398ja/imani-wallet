#!/usr/bin/env bash
# Create (once) the Imani plan prices in a Stripe TEST account and print SUBSCRIPTION_PRICES.
# Idempotent: prices are found by lookup_key and only created if missing.
set -euo pipefail
: "${STRIPE_SECRET_KEY:?set STRIPE_SECRET_KEY (sk_test_...)}"
case "$STRIPE_SECRET_KEY" in sk_test_*) ;; *) echo "refusing: not a test key" >&2; exit 1 ;; esac
API=https://api.stripe.com/v1
auth=(-u "$STRIPE_SECRET_KEY:")

product() { # name tier -> id. Found by its tier metadata; renamed in place if the name changed.
  local id
  id=$(curl -s "${auth[@]}" "$API/products/search" --data-urlencode "query=metadata['imani_tier']:'$2'" -G | sed -n 's/.*"id": "\(prod_[^"]*\)".*/\1/p' | head -1)
  if [ -n "$id" ]; then
    curl -s "${auth[@]}" "$API/products/$id" -d name="$1" >/dev/null
  else
    id=$(curl -s "${auth[@]}" "$API/products" -d name="$1" -d "metadata[imani_tier]=$2" | sed -n 's/.*"id": "\(prod_[^"]*\)".*/\1/p' | head -1)
  fi
  echo "$id"
}
price() { # product tier term amount interval -> id
  # The currency and amount are in the lookup key, so a price change makes a NEW Price (Stripe
  # prices are immutable) instead of finding the old one. Every plan is priced in GBP.
  local key="imani_$2_$3_gbp$4" id
  id=$(curl -s "${auth[@]}" -G "$API/prices" -d "lookup_keys[]=$key" | sed -n 's/.*"id": "\(price_[^"]*\)".*/\1/p' | head -1)
  [ -n "$id" ] || id=$(curl -s "${auth[@]}" "$API/prices" -d product="$1" -d currency=gbp -d unit_amount="$4" \
    -d "recurring[interval]=$5" -d lookup_key="$key" -d tax_behavior=inclusive | sed -n 's/.*"id": "\(price_[^"]*\)".*/\1/p' | head -1)
  echo "$id"
}
# As published on www.imani.casa/pricing, VAT inclusive: Essentials £8/month or £70/year, Pro
# £11/month or £100/year. Essentials is the `basic` tier (the id licences carry; only the name
# changed). Starter is free and has no price. Town / BID Partner is arranged with us ("Contact
# us") and is never sold by card, so it has no price here either.
basic=$(product "Imani Essentials" basic); pro=$(product "Imani Pro" pro)
echo "SUBSCRIPTION_PRICES=basic:monthly=$(price "$basic" basic monthly 800 month),basic:annual=$(price "$basic" basic annual 7000 year),pro:monthly=$(price "$pro" pro monthly 1100 month),pro:annual=$(price "$pro" pro annual 10000 year)"
