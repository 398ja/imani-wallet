# The purchase issuer.
#
#   docker build -f services/purchase-issuer/Dockerfile -t imani-purchase-issuer .
#
# Built from the REPO ROOT, and unlike its two siblings that is not about
# sharing a reader with the wallet. This service imports `@imani/money` for
# `getDecimals`, and that import is load-bearing: the code once hardcoded
# `faceDecimals: 2`, which for XAF — a zero-decimal currency and a primary
# market — turns a 5000 payment into a coupon worth 50. A second currency table
# in this image could disagree with the wallet's, and the disagreement would be
# denominated in somebody's money.
FROM node:20-alpine

WORKDIR /app

# EXACT versions, matching what the wallet resolves. The same rule as audit-api
# and wallet-api, and their comments record why: caret ranges floated
# @noble/hashes a full major ahead of the tested code in an image whose job was
# verifying signatures.
#
# Here the stakes are the same shape. `@noble/curves` and `nostr-tools` produce
# the NIP-98 signature that authorises MINTING against a stall's credential. A
# silent major bump is a signing library nobody tested doing the one thing this
# service exists to do.
#
# No `ws`. Unlike its siblings, this service never touches a relay: it talks
# HTTP to payment-adapter and to the gateway, and nothing else. Adding it would
# imply a relay dependency that does not exist.
RUN npm install --no-package-lock --omit=dev \
      @noble/curves@2.0.1 \
      @noble/hashes@1.8.0 \
      nostr-tools@2.24.1 \
      tsx@4.19.2

COPY services/purchase-issuer ./services/purchase-issuer

# The shared currency table, mounted where a bare Node resolver will find it.
#
# The app resolves `@imani/*` through a vite alias to `packages/*/src`. The
# container has no vite, so the alias does not exist and the import fails at
# REQUIRE TIME — wallet-api's image booted fine under the test suite and died
# immediately in the container for exactly this reason. Copied rather than
# npm-installed because the package points `exports` at source and ships no
# dist, which is this repo's convention; tsx compiles it on load.
COPY packages/money ./node_modules/@imani/money
# The stall's merchant-record rules (imani-wallet#312): the validity a card coupon is minted for
# must be read exactly as the wallet's Sell screen reads it. Source-pointing, like licence.
COPY packages/merchant-record ./node_modules/@imani/merchant-record

# ...except `@imani/money` is the ONE package that does not follow that
# convention. `wallet-core` and the rest point `exports` at `./src/index.ts`,
# which tsx compiles on load; money points at `./dist/index.cjs`, ships no dist,
# and has dist in .gitignore. So the copy above lands a package Node cannot
# resolve, and the container died on `Cannot find module .../dist/index.cjs`.
#
# Rewritten to source rather than built, because building would need tsup and a
# dev toolchain in a runtime image to produce a SECOND copy of the currency
# table — and the whole reason this package is here is that there must be only
# one. Pointing at source makes this image run the exact file the wallet's tests
# ran against.
RUN node -e "const p='node_modules/@imani/money/package.json',j=require('./'+p); \
      j.exports={'.':'./src/index.ts'}; j.main='./src/index.ts'; delete j.module; delete j.types; \
      require('fs').writeFileSync(p, JSON.stringify(j,null,2));"

# Tests are not runtime, and this service's tests construct credentials, which
# means they contain key material and signing paths. Inert as it sits, since the
# entrypoint never loads them — but "absent" is a property of the image and
# "inert" is a property of today's entrypoint.
RUN rm -rf services/purchase-issuer/__tests__ node_modules/@imani/money/src/__tests__ \
      node_modules/@imani/merchant-record/src/__tests__ \
      node_modules/@imani/money/tests

# Derive the requirement from the source instead of trusting the COPY above to
# stay current. Any new `@imani/*` import must exist in the image, so adding one
# without a COPY fails the BUILD rather than the container's first sale.
#
# It RESOLVES each package rather than checking the directory exists, and that
# distinction is not theoretical: the first version of this guard ran `test -d`,
# passed on a green build, and the container then died on `Cannot find module
# '@imani/money/dist/index.cjs'` — the directory was there and the package was
# unusable. A guard that confirms a folder while the import fails is exactly the
# kind that reads like coverage. `import()` is what the service itself does.
#
# Recursive `find -exec`, not a shell glob, so an import from a subdirectory is
# not invisible. NOT `grep -r --include`: this image's grep is BUSYBOX, which
# has no --include, and wallet-api's Dockerfile records that the flag errored,
# the loop iterated over nothing, and the guard passed while checking NOTHING.
#
# Runs AFTER the tests are removed, so an honest build is not failed by a
# test-only import.
RUN for p in $(find services/purchase-issuer -name '*.ts' -exec grep -hoE "@imani/[a-z-]+" {} + | sort -u); do \
      npx tsx -e "import('$p').then(m => { \
            if (Object.keys(m).length === 0) { console.error('FAIL: $p resolved to nothing'); process.exit(1); } \
          }).catch(e => { console.error('FAIL: $p imported by purchase-issuer but not usable in the image:', e.message); process.exit(1); })" \
        || exit 1; \
    done

# This service reaches NOWHERE outside its own tree, unlike its siblings, which
# copy in `src/lib` files. Asserted rather than assumed: a relative import
# climbing out of the service directory would resolve under vitest and fail at
# require time in the container, which is the same class of bug the guards above
# exist for. Verified by planting one: red.
RUN ! find services/purchase-issuer -name '*.ts' -exec grep -lE "from '\.\./\.\./" {} + \
      || (echo "FAIL: purchase-issuer reached outside its own tree" && exit 1)

# Where sealed credentials live. A VOLUME, because losing this file loses every
# stall's issuing credential and each one can only be replaced by that stall
# re-enrolling. The service degrades correctly — a missing file reads as "no
# stall has enrolled" and every purchase falls back to manual issuance — which
# is precisely why an unmounted volume would be silent.
VOLUME /var/lib/imani

ENV PURCHASE_ISSUER_PORT=8791
EXPOSE 8791

# No ENV defaults for the rest. `config.ts` refuses to boot without them, and
# a default here would defeat that: an image that supplies its own token or its
# own livemode flag is one whose misconfiguration is invisible again.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:8791/health || exit 1

# No shell form, so the process is PID 1 and receives SIGTERM directly.
# That matters more here than in a stateless service: the handler stops the
# LOOP so an in-flight pass can finish minting and delivering, and a process
# that never receives the signal gets killed mid-delivery instead.
CMD ["npx", "tsx", "services/purchase-issuer/server.ts"]
