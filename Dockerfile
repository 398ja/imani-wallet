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
