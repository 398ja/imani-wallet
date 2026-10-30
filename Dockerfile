# syntax=docker/dockerfile:1.7
#
# One build context. The five @imani/nap-* packages are ordinary npm
# dependencies (published as @398ja/nap-*, aliased to their import names in
# package.json), so `npm ci` installs them like anything else (#212):
#
#   docker build \
#     --build-arg VITE_RELAY_URL=wss://relay.staging.398ja.xyz \
#     --build-arg VITE_INTERNAL_RELAY_URL=ws://nostr-relay:7777 \
#     --build-arg VITE_GOOGLE_CLIENT_ID=<oauth-client-id>.apps.googleusercontent.com \
#     --build-arg VITE_TRUSTED_MINT_URLS=https://mint.staging.398ja.xyz \
#     --build-arg VITE_WEBSITE_BASE_URL=https://www.imani.casa \
#     -t imani-wallet .
#
# The 11 @imani/* wallet packages live in ./packages and are aliased to source.
FROM node:20-alpine AS builder
WORKDIR /build/imani-wallet
COPY package.json package-lock.json ./
RUN npm ci

# src/lib/relay.ts reads both of these through import.meta.env, which Vite
# substitutes textually at build time — so they are compiled into the bundle and
# this is one image per environment. Same contract as possa-merchant's VITE_*
# args. They are NOT secrets; the browser sees both.
ARG VITE_RELAY_URL
ARG VITE_INTERNAL_RELAY_URL
ENV VITE_RELAY_URL=$VITE_RELAY_URL
ENV VITE_INTERNAL_RELAY_URL=$VITE_INTERNAL_RELAY_URL

# Google Drive escrow (src/lib/drive.ts). A public OAuth *client id*, not a
# secret — the browser sends it to Google on every sign-in — but it is per-origin
# and per-deployment: the origin serving this bundle must be listed as an
# authorised JavaScript origin on that client, or Google refuses the token with
# no visible reason. Left unset, `driveConfigured()` is false and the Drive
# backup and restore buttons do not render at all.
ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

# The mints this build credits coupons from, comma-separated (src/lib/trustedMint.ts).
# Not a secret: it is a URL the browser already talks to. Set per environment, as
# the PUBLIC mint URL tokens carry in `m` (e.g. https://mint.staging.398ja.xyz).
#
# REQUIRED (#133 review, HIGH-1). This image is always a production bundle, and a
# production bundle that names no mint relies on /api/v1/config alone, which on
# beta and prod named none: the gate then had nothing to compare against. The
# wallet now holds coupons in that state rather than crediting them, so an image
# built without this would credit nothing until the gateway's env is fixed. The
# build fails instead (scripts/check-trusted-mint-build.sh). A throwaway local
# image may pass ALLOW_UNTRUSTED_MINT_BUILD=true, which is announced and must
# never be deployed.
ARG VITE_TRUSTED_MINT_URLS
ENV VITE_TRUSTED_MINT_URLS=$VITE_TRUSTED_MINT_URLS
ARG ALLOW_UNTRUSTED_MINT_BUILD=false
COPY scripts/check-trusted-mint-build.sh /tmp/check-trusted-mint-build.sh
RUN ALLOW_UNTRUSTED_MINT_BUILD="$ALLOW_UNTRUSTED_MINT_BUILD" sh /tmp/check-trusted-mint-build.sh

# The keys that sign vouchers this build believes, comma-separated 64-hex x-only keys
# (src/lib/issuerAllowlist.ts): the customer gateway's voucher issuing key. Not a secret.
# Coupons are refused offline when signed by any other key. Terminal credentials are
# refused outright unless their signer is listed, and with this EMPTY no terminal opens
# (#160 review, IW-15). Optional for the build so a wallet-only image still builds; a
# deployment with terminals must set it.
ARG VITE_VOUCHER_ISSUER_PUBKEYS=
ENV VITE_VOUCHER_ISSUER_PUBKEYS=$VITE_VOUCHER_ISSUER_PUBKEYS

# The licence SELLER's stall key, 64-hex x-only (src/lib/licenceStatus.ts licenceSellerPubkey): the
# signed `issuer` a licence must name, so a licence-shaped voucher another stall minted through the
# gateway and DM'd here grants nothing in this wallet and is never reported (imani-wallet#197 review,
# MEDIUM-3). Not a secret. Empty does not pin (logged once); the server pins regardless.
ARG VITE_LICENCE_SELLER_PUBKEY=
ENV VITE_LICENCE_SELLER_PUBKEY=$VITE_LICENCE_SELLER_PUBKEY

# The sister sites (#411, src/lib/sisterSites.ts): where Settings › Subscription › "Upgrade my plan"
# goes, and the only origins the wallet will sign a NAP login for. Per environment, e.g.
# https://subscription.imani.casa in production. Not secrets. Empty: that site is not part of this
# deployment, and the wallet says so rather than opening a guess.
ARG VITE_SUBSCRIPTION_SITE_URL=
ENV VITE_SUBSCRIPTION_SITE_URL=$VITE_SUBSCRIPTION_SITE_URL
ARG VITE_GIFTING_SITE_URL=
ENV VITE_GIFTING_SITE_URL=$VITE_GIFTING_SITE_URL

# Checkout codes for online shops (#402, src/lib/checkoutCodePorts.ts). "on" shows "Use online";
# anything else ships the feature dark, which is the default. Not a secret. imani-deploy's
# deploy-staging.sh already passes both; until they were declared here, the build silently ignored
# them and the button never showed (2026-10-30).
ARG VITE_CHECKOUT_CODES=
ENV VITE_CHECKOUT_CODES=$VITE_CHECKOUT_CODES
# The code store origin the stall's exposure figure is read from (src/lib/shopExposure.ts): the
# wallet host, which proxies /v1/checkout-codes same-origin. Empty: the exposure figure is not shown.
ARG VITE_CHECKOUT_CODES_URL=
ENV VITE_CHECKOUT_CODES_URL=$VITE_CHECKOUT_CODES_URL

# The public website, without a trailing path (src/lib/terms.ts): every new account accepts the
# Terms and Conditions at <this>/terms.html, today https://www.imani.casa/terms.html. Not a secret.
# REQUIRED (#357): a bundle without it cannot link to the terms, so it refuses to create any
# account. The build fails instead (scripts/check-website-base-url-build.sh). No escape hatch.
ARG VITE_WEBSITE_BASE_URL
ENV VITE_WEBSITE_BASE_URL=$VITE_WEBSITE_BASE_URL
COPY scripts/check-website-base-url-build.sh /tmp/check-website-base-url-build.sh
RUN sh /tmp/check-website-base-url-build.sh

COPY . .
# `tsc -b && vite build`. The tsc half typechecks ./packages through the paths
# mirror in tsconfig.app.json, and the nap packages through their published
# .d.ts, so drift in either fails the build here rather than at runtime.
RUN npm run build

FROM nginx:alpine
COPY --from=builder /build/imani-wallet/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# Deliberately not imani-apps' 9545: during the cutover both containers may be
# resolvable, and a stale `set $imani_apps http://...:9545` in the edge config
# should fail loudly rather than quietly hit the new app on the old port.
EXPOSE 9546
