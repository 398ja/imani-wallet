# The hosted audit API.
#
# Separate from the wallet's Dockerfile on purpose: that one builds a static
# bundle and serves it with nginx, this one runs a Node process. Sharing an image
# would ship a signing-capable browser bundle inside a service whose whole safety
# argument is that it cannot sign anything.
#
#   docker build -f services/audit-api/Dockerfile -t imani-audit-api .
#
# Built from the REPO ROOT, because the service imports src/lib/audit.ts — the
# same reader the wallet runs. That shared source is the point: a second
# implementation could tell an auditor a forged record is genuine.
FROM node:20-alpine

WORKDIR /app

# Only what the service actually needs at runtime. `npm ci` would install the
# wallet's whole toolchain — vite, tailwind, playwright-adjacent test deps — into
# an image that runs one HTTP server.
#
# tsx runs the TypeScript directly. A build step would emit JS that is no longer
# the file the tests ran against, for a service whose correctness argument rests
# on running exactly the reader the wallet does.
#
# EXACT versions, matching what the wallet resolves — verified, not assumed.
# Caret ranges here floated the image to @noble/hashes 2.4.0 while the tested
# code runs 1.8.0, a MAJOR bump in the library that computes nullifiers and
# verifies signatures. The service would have been auditing the stream with
# different crypto from the wallet that wrote it, which is precisely the drift
# this service shares source to avoid. Bump these with the wallet's lockfile,
# never independently.
RUN npm install --no-package-lock --omit=dev \
      nostr-tools@2.24.1 \
      @noble/curves@2.0.1 \
      @noble/hashes@1.8.0 \
      tsx@4.19.2 \
      ws@8.21.3

COPY services/audit-api ./services/audit-api
COPY src/lib/audit.ts src/lib/attestationKind.ts ./src/lib/

ENV AUDIT_API_PORT=8090
ENV AUDIT_RELAY_URL=ws://nostr-relay:7777
EXPOSE 8090

# No shell form, so the process is PID 1 and receives SIGTERM directly —
# otherwise a `docker stop` waits the full grace period on every deploy.
CMD ["npx", "tsx", "services/audit-api/server.ts"]
