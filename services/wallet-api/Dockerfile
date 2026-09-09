# The wallet API.
#
# Mirrors services/audit-api/Dockerfile, and the differences are the interesting
# part:
#
#   docker build -f services/wallet-api/Dockerfile -t imani-wallet-api .
#
# Built from the REPO ROOT, because the service's tests authenticate using
# src/lib/nip98.ts — the wallet's own signer. The verifier here and the signer
# there are two halves of one protocol, and keeping them in one repo is what
# makes it possible to test them against each other rather than against a
# shared assumption.
FROM node:20-alpine

WORKDIR /app

# EXACT versions, matching what the wallet resolves — the same rule as the audit
# API, for the same reason. @noble/curves verifies the signature that IS the
# security boundary here; a floated major would change that check silently.
#
# The lesson is already recorded on the audit API image, where caret ranges
# floated @noble/hashes a full major ahead of the tested code. Bump these with
# the wallet's lockfile, never independently.
#
# `nostr-tools` and `ws` are here as of the recipient check: the service now
# asks the relay whether a recipient is a stall. It was previously shorter than
# the audit API's list, and the container went from booting to dying the moment
# that import landed — caught by running the image, not by the suite, which
# resolves everything through vite.
#
# `ws` because Node 20 has no global WebSocket. Without it nostr-tools connects
# to nothing and every query resolves `[]` with NO error — which here would read
# as "not a stall" and ALLOW exactly the send this check exists to refuse. The
# audit API carries the same warning; there it produced false accusations,
# here it would produce lost coupons.
RUN npm install --no-package-lock --omit=dev \
      @noble/curves@2.0.1 \
      @noble/hashes@1.8.0 \
      nostr-tools@2.24.1 \
      ws@8.21.3 \
      tsx@4.19.2

COPY services/wallet-api ./services/wallet-api

# The shared money logic, mounted where a bare Node resolver will find it.
#
# The app resolves `@imani/*` through a vite alias to `packages/*/src`. The
# container has no vite, so the alias does not exist and the import fails at
# require time — the service booted fine under the test suite and died
# immediately in the image. Caught by running the container; a suite that only
# ever exercised the alias could not have seen it.
#
# Copied into node_modules rather than npm-installed because the package points
# `exports` at ./src/index.ts and ships no dist, which is this repo's own
# convention. tsx compiles it on load, exactly as it does the service.
#
# This is the SAME source the app imports, which is the entire point: two
# implementations of what a spend costs is a bug no test can catch.
COPY packages/wallet-core ./node_modules/@imani/wallet-core

# `@imani/voucher-send` is imported by wallet-core for its `Voucher` TYPE only,
# and types are erased, so the package is not needed at runtime. Asserted here
# rather than assumed: if a value import ever appears, the container fails to
# boot, so the build checks now instead.
RUN ! grep -rnE "^import [^t]" node_modules/@imani/wallet-core/src \
      | grep "@imani/voucher-send" \
    || (echo "FAIL: wallet-core gained a runtime import of voucher-send" && exit 1)

# The tests are not runtime, and more than that: this service's safety argument
# is that it holds no code path which can sign. The suite necessarily imports
# the wallet's SIGNER to produce test credentials, so shipping it would put
# signing capability inside the one image whose claim is that it has none.
#
# Inert as it sits — the entrypoint never loads it, and src/lib is not even
# present, so the import could not resolve. Removed anyway, because "inert" is
# a property of today's entrypoint and "absent" is a property of the image.
RUN rm -rf services/wallet-api/__tests__ node_modules/@imani/wallet-core/src/__tests__ \
      services/wallet-api/sign.mjs

# Prove the claim rather than assert it: fail the BUILD if anything that can
# sign is reachable in the shipped tree. A comment saying the service cannot
# sign goes stale the first time someone adds an import; this does not.
# The Dockerfile itself is copied in by the COPY above and NAMES these symbols
# in this very check, so scanning the whole directory matched the guard against
# its own pattern and failed an honest build. Caught by running it: an
# unplanted build went red before a planted one ever did.
#
# Scoped to *.ts, which is the only thing the entrypoint can execute anyway.
# Covers the shared package too, which is copied in above: wallet-core is the
# money logic, and it gaining a signing path would be exactly as dangerous here.
#
# NOT scoped to *.ts. It was, and `sign.mjs` — a tool whose entire job is to
# sign — walked straight into the image past a guard that only looked at
# TypeScript. The build went green while shipping the exact capability the
# guard exists to exclude. Every executable extension is scanned now.
RUN ! find services/wallet-api node_modules/@imani \
      \( -name '*.ts' -o -name '*.mjs' -o -name '*.js' -o -name '*.cjs' \) -exec \
      grep -lE "finalizeEvent|schnorr\.sign|generateSecretKey|getSigner" {} + \
    || (echo "FAIL: signing capability reachable in wallet-api image" && exit 1)

# The same guard for SEALING, which arrived with the prepare endpoint.
#
# Signing was never the only way to spend. A NIP-17 send is a rumor sealed to a
# conversation key derived from the customer's private key, so a module that
# imports `nip17` or `nip44` could wrap and deliver a send without ever calling
# `finalizeEvent` — the guard above would stay green while the image gained the
# exact capability it exists to exclude.
#
# Matched on the IMPORT, not on the name: `prepare.ts` explains in a comment
# that the caller passes the returned rumor to `nip17.wrapEvent`, and a guard
# that failed on the word would make the file undocumentable. Verified by
# building with that comment present and with a planted import; only the second
# goes red.
RUN ! find services/wallet-api node_modules/@imani \
      \( -name '*.ts' -o -name '*.mjs' -o -name '*.js' -o -name '*.cjs' \) -exec \
      grep -lE "(import|require).*(nostr-tools/(nip17|nip44)|[{,] *nip(17|44) *[,}])" {} + \
    || (echo "FAIL: gift-wrap sealing reachable in wallet-api image" && exit 1)

ENV PORT=8788
ENV WALLET_API_RELAY_URL=ws://nostr-relay:7777
EXPOSE 8788

# No shell form, so the process is PID 1 and receives SIGTERM directly —
# otherwise a `docker stop` waits the full grace period on every deploy.
CMD ["npx", "tsx", "services/wallet-api/server.ts"]
