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
# Baked into the site bundle. The Google client id lets a stall open its wallet key from Drive.
# Its OAuth client must list the origin the site is served from as an authorised JS origin.
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
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
      tsx@4.19.2

COPY services/subscription ./services/subscription
COPY src/lib/licenceIssue.ts src/lib/voucherToken.ts ./src/lib/
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
