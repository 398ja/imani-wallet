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
# Note this list is SHORTER than the audit API's: no `ws`, no `nostr-tools` at
# runtime. This service holds no relay connection — it answers from the request
# alone — and the smaller surface is a property worth keeping.
RUN npm install --no-package-lock --omit=dev \
      @noble/curves@2.0.1 \
      @noble/hashes@1.8.0 \
      tsx@4.19.2

COPY services/wallet-api ./services/wallet-api

# The tests are not runtime, and more than that: this service's safety argument
# is that it holds no code path which can sign. The suite necessarily imports
# the wallet's SIGNER to produce test credentials, so shipping it would put
# signing capability inside the one image whose claim is that it has none.
#
# Inert as it sits — the entrypoint never loads it, and src/lib is not even
# present, so the import could not resolve. Removed anyway, because "inert" is
# a property of today's entrypoint and "absent" is a property of the image.
RUN rm -rf services/wallet-api/__tests__

# Prove the claim rather than assert it: fail the BUILD if anything that can
# sign is reachable in the shipped tree. A comment saying the service cannot
# sign goes stale the first time someone adds an import; this does not.
# The Dockerfile itself is copied in by the COPY above and NAMES these symbols
# in this very check, so scanning the whole directory matched the guard against
# its own pattern and failed an honest build. Caught by running it: an
# unplanted build went red before a planted one ever did.
#
# Scoped to *.ts, which is the only thing the entrypoint can execute anyway.
RUN ! find services/wallet-api -name '*.ts' -exec \
      grep -lE "finalizeEvent|schnorr\.sign|generateSecretKey|getSigner" {} + \
    || (echo "FAIL: signing capability reachable in wallet-api image" && exit 1)

ENV PORT=8788
EXPOSE 8788

# No shell form, so the process is PID 1 and receives SIGTERM directly —
# otherwise a `docker stop` waits the full grace period on every deploy.
CMD ["npx", "tsx", "services/wallet-api/server.ts"]
