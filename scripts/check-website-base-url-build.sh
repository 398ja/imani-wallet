#!/bin/sh
# Refuse to build a wallet image that names no website (imani-wallet#357).
#
# Every new account must accept the Terms and Conditions, which live at
# <VITE_WEBSITE_BASE_URL>/terms.html (today https://www.imani.casa/terms.html).
# A bundle without the base URL cannot link to them, so it refuses to create
# any account at all (src/lib/terms.ts): an image that cannot sign anyone up is
# a broken deploy, and the place to catch it is here, before it ships.
#
# The value must be an https URL with a host and no userinfo, query or
# fragment, matching what `websiteBaseUrl` in src/lib/terms.ts accepts: a value
# the wallet would treat as unset is as bad as no value.
#
# There is no escape hatch: unlike a trusted mint, nothing about a throwaway
# local image is harder with the real public website named.
#
# Usage: check-website-base-url-build.sh  (reads VITE_WEBSITE_BASE_URL from the
#        environment). POSIX sh, so it runs in the node:alpine builder stage.
set -eu

base=$(printf '%s' "${VITE_WEBSITE_BASE_URL:-}" | tr -d ' ')

if [ -z "$base" ]; then
  echo "ERROR: VITE_WEBSITE_BASE_URL is unset (imani-wallet#357)." >&2
  echo "       Pass --build-arg VITE_WEBSITE_BASE_URL=<the public website>, e.g. https://www.imani.casa." >&2
  echo "       New accounts accept the Terms and Conditions at <that URL>/terms.html." >&2
  exit 1
fi

fail() { echo "ERROR: VITE_WEBSITE_BASE_URL '$base' $1 (imani-wallet#357)." >&2; exit 1; }

case "$base" in
  https://*) ;;
  *) fail "is not an https URL" ;;
esac
rest=${base#*://}
authority=${rest%%/*}
[ -n "$authority" ] || fail "names no host"
case "$authority" in *@*) fail "carries userinfo" ;; esac
case "$base" in *\?*|*\#*) fail "carries a query or fragment" ;; esac

echo "terms for this image: ${base%/}/terms.html"
