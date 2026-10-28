# imani-mailer: the shared outbound mailer (#410).
#
#   docker build -f services/imani-mailer/Dockerfile -t imani-mailer .
#
# Built from the REPO ROOT like its siblings, though it imports nothing outside its own directory
# (asserted below). Configuration is environment only, and it refuses to boot without a complete
# production configuration unless MAILER_ENV=development: see services/imani-mailer/README.md.
FROM node:20-alpine

WORKDIR /app

# EXACT versions, matching package-lock.json, for the same reason as the other services: a caret
# range would float the library that speaks SMTP, negotiates TLS and signs DKIM to a version no
# test ran against.
RUN npm install --no-package-lock --omit=dev \
      nodemailer@8.0.2 \
      tsx@4.19.2

COPY services/imani-mailer ./services/imani-mailer

# Tests are not runtime: they hold fixture tokens and generate keys.
RUN rm -rf services/imani-mailer/__tests__

# Nothing outside the service's own tree, so nothing that resolves under vitest can fail to
# resolve here.
RUN ! find services/imani-mailer -name '*.ts' -exec grep -lE "from '\.\./" {} + \
      || (echo "FAIL: imani-mailer reached outside its own tree" && exit 1)

# Fails the BUILD if the entrypoint cannot load (a missing dependency), not the first send.
RUN MAILER_ENV=development MAILER_TRANSPORT=refuse MAILER_FROM_ADDRESS=build@imani.invalid \
      MAILER_LINK_HOSTS=imani.invalid \
      MAILER_CLIENTS='[{"id":"build","tokenSha256":"0000000000000000000000000000000000000000000000000000000000000000","templates":["gift-receipt"]}]' \
      npx tsx services/imani-mailer/cli.ts check > /dev/null

# Idempotency keys and suppressions (MAILER_STATE_FILE). A VOLUME: losing it re-sends recent
# emails on retry and forgets every hard bounce, so it must not live in the container layer.
RUN mkdir -p /var/lib/imani-mailer && chown node:node /var/lib/imani-mailer
VOLUME /var/lib/imani-mailer

USER node
ENV MAILER_PORT=8095 \
    MAILER_STATE_FILE=/var/lib/imani-mailer/state.json \
    NODE_ENV=production
EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8095/health || exit 1

# Exec form, so SIGTERM reaches the process and in-flight sends finish.
CMD ["npx", "tsx", "services/imani-mailer/server.ts"]
