# syntax=docker/dockerfile:1.7-labs
# subscription.imani.casa: the API and the site, one origin.
#
#   docker build -f services/subscription/Dockerfile -t imani-subscription .
#
# Built from the REPO ROOT, like wallet-api: the service imports `licenceMetadataJson` from
# src/lib/licenceIssue.ts and `@imani/licence`, so the licence it mints is written by the exact code
# the wallet's tests check it against. A copy would drift.

# ---- the site: Vite + React + Tailwind, the wallet's stack and UI components
FROM node:20-alpine AS site
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tailwind.config.js tsconfig*.json ./
COPY src ./src
COPY shared ./shared
# All workspace packages: the site uses wallet components (IdentityInline) that reach several.
COPY packages ./packages
COPY apps/subscription ./apps/subscription
# The root tsconfig.json references every app's tsconfig (e.g. apps/gifting once #410 lands), and
# Vite's esbuild reads that reference graph. Only the tsconfig files are needed for it to resolve,
# so the image never ships another site's code.
COPY --parents apps/*/tsconfig.json ./
# Baked into the site bundle: the ONE wallet origin the site accepts a NAP signer from (#411). The
# wallet opens this site and signs its login over postMessage; a signer anywhere else is ignored.
# Per environment (e.g. https://wallet.imani.casa in production), so REQUIRED: a site built without
# it could never be signed in, which is a build that should fail rather than ship.
ARG VITE_WALLET_ORIGIN
ENV VITE_WALLET_ORIGIN=$VITE_WALLET_ORIGIN
RUN test -n "$VITE_WALLET_ORIGIN" || { echo "set --build-arg VITE_WALLET_ORIGIN=<the wallet's origin>" >&2; exit 1; }
# Served at the root of its own origin (subscription.imani.casa). Set to e.g. /subscription only
# together with SUBSCRIPTION_BASE_PATH on the service.
ARG SUBSCRIPTION_BASE="/"
ENV SUBSCRIPTION_BASE=$SUBSCRIPTION_BASE
RUN npx vite build --config apps/subscription/vite.config.ts

# ---- the service
FROM node:20-alpine
WORKDIR /app

# EXACT versions, as purchase-issuer and wallet-api pin them: these sign NIP-98 and the seller's
# warrant, and a floated major is a signing library nobody tested.
RUN npm install --no-package-lock --omit=dev \
      @noble/curves@2.0.1 \
      @noble/hashes@1.8.0 \
      nostr-tools@2.24.1 \
      ws@8.21.3 \
      tsx@4.19.2 \
      @imani/nap-core@npm:@398ja/nap-core@0.13.0 \
      @imani/nap-server@npm:@398ja/nap-server@0.13.0

COPY services/subscription ./services/subscription
COPY src/lib/licenceIssue.ts src/lib/voucherToken.ts src/lib/giftWrap.ts src/lib/subscriptionStatus.ts src/lib/verificationBadge.ts ./src/lib/
COPY packages/licence ./node_modules/@imani/licence
COPY --from=site /build/apps/subscription/dist ./site
RUN rm -rf services/subscription/__tests__

# Every @imani import must be in the image, or it boots under tests and dies in the container.
RUN for p in $(find services/subscription -name '*.ts' -exec grep -hoE "@imani/[a-z-]+" {} + | sort -u); do \
      test -d "node_modules/$p" || { echo "FAIL: $p imported but not copied"; exit 1; }; \
    done

ENV PORT=8090 \
    SUBSCRIPTION_STATIC_DIR=/app/site \
    SUBSCRIPTION_CATALOG_PATH=/app/services/subscription/catalog.json \
    SUBSCRIPTION_LEDGER_PATH=/data/ledger.json
# Owned by `node` BEFORE the VOLUME line, so a fresh volume inherits it. Without this the ledger
# write failed with EACCES on the first grant (found running the image against staging).
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8090
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8090/health || exit 1
CMD ["npx", "tsx", "services/subscription/server.ts"]
