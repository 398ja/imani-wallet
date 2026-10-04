# syntax=docker/dockerfile:1.7
#
# Two build contexts, because the five nap packages are still a sibling repo
# consumed straight from source — vite.config.ts and tsconfig.app.json both alias
# `../nap/packages/*/src/index.ts`:
#
#   docker build --build-context nap=../nap \
#     --build-arg VITE_RELAY_URL=wss://relay.staging.398ja.xyz \
#     --build-arg VITE_INTERNAL_RELAY_URL=ws://nostr-relay:7777 \
#     --build-arg VITE_GOOGLE_CLIENT_ID=<oauth-client-id>.apps.googleusercontent.com \
#     --build-arg VITE_TRUSTED_MINT_URLS=https://mint.staging.398ja.xyz \
#     -t imani-wallet .
#
# The /build/{imani-wallet,nap} layout below reproduces the on-disk sibling shape
# exactly, so neither config file needs a Docker-only variant to drift out of
# sync with the one developers use.
#
# The 11 @imani/* packages need no such trick: they live in ./packages now.
FROM node:20-alpine AS builder
WORKDIR /build

# nap first — its own workspace install, its own cache layer, and it changes far
# less often than the app.
#
# This install is NOT optional. nap's sources bare-import nostr-tools,
# @noble/hashes and react, and Node resolution from /build/nap/packages never
# reaches /build/imani-wallet/node_modules.
#
# It is also what reintroduces react 19.2.4 alongside the wallet's 19.2.3 — the
# exact duplicate that `resolve.dedupe` in vite.config.ts exists to collapse.
# Delete that dedupe and this image builds cleanly and serves a BLANK PAGE, with
# a 200 and a well-formed index.html. Nothing but a browser catches it.
# `packages` is copied BEFORE the install, not after: nap is an npm WORKSPACES
# root (`workspaces: ["packages/*"]`), so react, @types/react and nostr-tools are
# declared by the workspace packages, not the root. Install with packages/ absent
# and npm happily installs the root's five devDeps and nothing else — then `tsc`
# fails with "Cannot find module 'react'" pointing at ../nap sources, which reads
# like a tsconfig problem and is not one.
COPY --from=nap package.json package-lock.json ./nap/
COPY --from=nap packages ./nap/packages
RUN cd nap && npm ci --ignore-scripts

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
# Since #133 the wallet also learns the mint from /api/v1/config at start-up, before
# its first receive, so an image without this is still gated. Setting it means the
# gate needs no network answer at all, which is why an unset value is announced
# loudly here rather than failing the build: imani-deploy's beta build does not pass
# it yet, and failing would break that pipeline for a defence-in-depth setting.
ARG VITE_TRUSTED_MINT_URLS
ENV VITE_TRUSTED_MINT_URLS=$VITE_TRUSTED_MINT_URLS
RUN if [ -z "$VITE_TRUSTED_MINT_URLS" ]; then \
      echo "WARNING: VITE_TRUSTED_MINT_URLS is unset. The trusted-mint gate will rely on /api/v1/config alone (imani-wallet#133)." >&2; \
    fi

COPY . .
# `tsc -b && vite build`. The tsc half typechecks ./packages AND ../nap through
# the paths mirror in tsconfig.app.json, so drift in either fails the build here
# rather than at runtime.
RUN npm run build

FROM nginx:alpine
COPY --from=builder /build/imani-wallet/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# Deliberately not imani-apps' 9545: during the cutover both containers may be
# resolvable, and a stale `set $imani_apps http://...:9545` in the edge config
# should fail loudly rather than quietly hit the new app on the old port.
EXPOSE 9546
