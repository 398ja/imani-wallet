#!/bin/sh
# Refuse to build a wallet image that names no trusted mint (imani-wallet#133).
#
# The image is a PRODUCTION bundle (`vite build`), and a production bundle with
# no VITE_TRUSTED_MINT_URLS trusts only what /api/v1/config says. On beta and
# prod that config named no mint at all, so the gate had nothing to compare
# against and credited coupons from any mint: #133 itself. The wallet now holds
# such coupons instead of crediting them, but an image that cannot credit ANY
# coupon until someone fixes the gateway's env is a broken deploy, and the place
# to catch it is here, before it ships.
#
# Each entry must be an http(s) URL with no userinfo, query or fragment, matching
# what `normaliseMintUrl` in src/lib/trustedMint.ts will accept: an entry the
# wallet would silently drop is as bad as no entry.
#
# ALLOW_UNTRUSTED_MINT_BUILD=true is the explicit escape hatch for a throwaway
# local image. It is announced, and it is never set by imani-deploy.
#
# Usage: check-trusted-mint-build.sh  (reads VITE_TRUSTED_MINT_URLS and
#        ALLOW_UNTRUSTED_MINT_BUILD from the environment). POSIX sh, so it runs
#        in the node:alpine builder stage.
set -eu

urls="${VITE_TRUSTED_MINT_URLS:-}"
allow="${ALLOW_UNTRUSTED_MINT_BUILD:-}"

if [ -z "$(printf '%s' "$urls" | tr -d ' ,')" ]; then
  if [ "$allow" = "true" ]; then
    echo "WARNING: building with NO trusted mint (ALLOW_UNTRUSTED_MINT_BUILD=true)." >&2
    echo "         This image holds every coupon until /api/v1/config names a mint. Never deploy it." >&2
    exit 0
  fi
  echo "ERROR: VITE_TRUSTED_MINT_URLS is unset (imani-wallet#133)." >&2
  echo "       Pass --build-arg VITE_TRUSTED_MINT_URLS=<public mint URL tokens carry in 'm'>," >&2
  echo "       e.g. https://mint.staging.398ja.xyz. For a throwaway local image only," >&2
  echo "       --build-arg ALLOW_UNTRUSTED_MINT_BUILD=true." >&2
  exit 1
fi

bad=0
old_ifs=$IFS
IFS=','
for raw in $urls; do
  entry=$(printf '%s' "$raw" | tr -d ' ')
  [ -z "$entry" ] && continue
  case "$entry" in
    http://*|https://*) ;;
    *) echo "ERROR: trusted mint '$entry' is not an http(s) URL." >&2; bad=1; continue ;;
  esac
  rest=${entry#*://}
  authority=${rest%%/*}
  case "$authority" in
    *@*) echo "ERROR: trusted mint '$entry' carries userinfo." >&2; bad=1 ;;
  esac
  case "$entry" in
    *\?*|*\#*) echo "ERROR: trusted mint '$entry' carries a query or fragment." >&2; bad=1 ;;
  esac
  [ -z "$authority" ] && { echo "ERROR: trusted mint '$entry' names no host." >&2; bad=1; }
done
IFS=$old_ifs

[ "$bad" -eq 0 ] || exit 1
echo "trusted mint(s) for this image: $urls"
