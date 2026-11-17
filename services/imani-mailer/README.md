# imani-mailer

The shared outbound mailer (#410). Services ask it to send a **named template** to **one
recipient** with the template's **fields**; it renders, checks and hands the message to an SMTP
server. Callers never build bodies, choose headers or hold mail credentials.

```
POST   /v1/send           {template, to, fields, idempotencyKey}   client token, template scope
POST   /v1/suppressions   {to, reason: hard-bounce|complaint|manual}  client token with bounce
DELETE /v1/suppressions   {to}                                      client token with bounce
POST   /v1/suppressions/check {to} -> {suppressed, reason?}         client token with bounce or check
GET    /v1/templates      what this client may send, with field types
GET    /health            liveness (no auth)
GET    /ready             SMTP answers EHLO / STARTTLS / AUTH (no auth)
GET    /metrics           Prometheus (MAILER_METRICS_TOKEN as bearer when set)
```

From another service, use `client.ts`:

```ts
const mail = mailerClient({ baseUrl: process.env.MAILER_URL!, token: process.env.MAILER_TOKEN! })
const out = await mail.send({ template: 'gift-claim', to, fields, idempotencyKey: `${eventId}:claim` })
if (!out.ok && out.retryable) /* retry later with the SAME key */
else if (!out.ok) /* park it for a person */
```

| Answer | Meaning | Caller does |
| --- | --- | --- |
| 202 `ok` | the SMTP server accepted it (`duplicate: true` if this key already sent) | done |
| 400 `invalid_request` / `invalid_fields` / `unknown_template` | the request is wrong | fix the caller |
| 401 / 403 `template_not_allowed` | wrong token, or a template outside this client's list | fix configuration |
| 403 `recipient_refused` | the domain is denied, or not on the allow list | do not retry |
| 409 `recipient_suppressed` | hard bounce or complaint on record | tell the buyer, do not retry |
| 409 `idempotency_conflict` | this key already sent a DIFFERENT message | caller bug |
| 429 `rate_limited` | `Retry-After` seconds | retry later |
| 502 `transport_rejected` | the server refused this message for good (5xx to MAIL/RCPT/DATA) | do not retry |
| 503 `transport_unavailable` | network, 4xx, TLS, AUTH: nothing was sent | retry later |

## Security

- **Callers**: each client has its own random token; configuration holds only its **sha256**
  (`MAILER_CLIENTS`), compared in constant time. Each client lists the templates it may send;
  only clients with `bounce` may manage suppressions. A client with `check` (purchase-issuer's gift
  tracker) may only ask whether an address is suppressed, which is how a hard bounce reported by the
  provider webhook reaches the buyer (`gift-bounced`). A send may carry `unsubscribeUrl` (checked
  against `MAILER_LINK_HOSTS`): the mailer then adds RFC 8058 `List-Unsubscribe` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (the gift reminders use it). Internal network only, never behind the edge.
- **Content**: templates are data, validated at boot. Fields are typed: `line` (one line, CR/LF and
  control characters removed, so no header injection), `text`, `url` (https, allowed hosts only, no
  userinfo), `email`. URLs and emails can never appear in a subject. Unknown fields are refused.
  The HTML part is generated from the text with every value escaped. No tracking pixels, no
  rewritten links: a claim link's `#fragment` arrives untouched.
- **Recipients**: exactly one, syntax-checked, then deny/allow domains, suppressions, and
  per-recipient, per-client and global rate limits.
- **Transport**: STARTTLS is **required** when `starttls` is chosen (no silent downgrade),
  certificates verified (system CAs plus `MAILER_SMTP_CA_FILE`), TLS 1.2 minimum. Credentials over
  clear text need an explicit development-only opt-in. Optional DKIM, refused unless its domain
  aligns with From.
- **Logs and state**: a recipient is a keyed HMAC tag (`MAILER_TAG_KEY`), never an address. No
  bodies, subjects, links or tokens are logged. The state file (idempotency, suppressions) holds no
  address, is written atomically with mode 0600, and a corrupt one refuses the boot.
- **Fail closed**: `MAILER_ENV` defaults to `production`, which refuses every development shortcut
  (clear-text SMTP, unverified TLS, http links, `*` template scopes, the `log` transport, a missing
  tag key or state file). The default transport `refuse` sends nothing.

## Configuration

Every secret may be given as `NAME_FILE` (Docker/Kubernetes secrets) instead of `NAME`, never both.
`npx tsx services/imani-mailer/cli.ts check` loads the environment as the server does and reports.

| Variable | Default | |
| --- | --- | --- |
| `MAILER_ENV` | `production` | `development` allows the shortcuts below |
| `MAILER_HOST`, `MAILER_PORT` | `0.0.0.0`, `8095` | |
| `MAILER_TRANSPORT` | `refuse` | `smtp`; `log` and `refuse` are development only |
| `MAILER_SMTP_HOST`, `MAILER_SMTP_PORT` | –, 587 (465 for `tls`) | |
| `MAILER_SMTP_SECURITY` | `starttls` | `tls` (implicit), `starttls` (required), `none` (development) |
| `MAILER_SMTP_USER`, `MAILER_SMTP_PASSWORD(_FILE)` | – | together or not at all |
| `MAILER_SMTP_CA_FILE` | – | extra CA(s) trusted for the SMTP server |
| `MAILER_SMTP_TLS_VERIFY` | `true` | `false` is development only |
| `MAILER_SMTP_TLS_MIN_VERSION` | `TLSv1.2` | or `TLSv1.3` |
| `MAILER_SMTP_ALLOW_PLAINTEXT_AUTH` | `false` | credentials over `none` |
| `MAILER_SMTP_CLIENT_NAME`, `MAILER_SMTP_POOL`, `MAILER_SMTP_MAX_CONNECTIONS` | –, `true`, 3 | |
| `MAILER_SMTP_CONNECT_TIMEOUT_MS`, `MAILER_SMTP_SOCKET_TIMEOUT_MS` | 10000, 30000 | |
| `MAILER_DKIM_DOMAIN`, `MAILER_DKIM_SELECTOR`, `MAILER_DKIM_PRIVATE_KEY(_FILE)` | – | all three or none; `cli.ts dkim-dns` prints the TXT record |
| `MAILER_FROM_ADDRESS` | **required** | the only sender address |
| `MAILER_FROM_NAME`, `MAILER_REPLY_TO` | `Imani`, – | templates may set their own display name |
| `MAILER_MESSAGE_ID_DOMAIN` | From's domain | |
| `MAILER_LINK_HOSTS` | **required** | `host[:port]` list links may point at |
| `MAILER_LINK_ALLOW_HTTP` | `false` | development only |
| `MAILER_RECIPIENT_ALLOW_DOMAINS`, `MAILER_RECIPIENT_DENY_DOMAINS` | – | subdomains included |
| `MAILER_SANDBOX_REDIRECT` | – | staging: every message goes here, subject marked `[sandbox]` |
| `MAILER_CLIENTS(_FILE)` | **required** | JSON `[{id, tokenSha256, templates, bounce?, perMinute?}]`; `cli.ts token` makes one |
| `MAILER_TEMPLATES_FILE` | – | JSON of extra templates; a name there replaces the built-in |
| `MAILER_TAG_KEY(_FILE)` | random in development | 32+ bytes hex; required in production |
| `MAILER_STATE_FILE` | `/var/lib/imani-mailer/state.json` in the image | required in production |
| `MAILER_IDEMPOTENCY_TTL_HOURS` | 168 | |
| `MAILER_RATE_PER_RECIPIENT_HOUR`, `MAILER_RATE_GLOBAL_MINUTE` | 10, 600 | per client: `perMinute` |
| `MAILER_MAX_BODY_BYTES` | 32768 | |
| `MAILER_METRICS_TOKEN(_FILE)` | – | when set, `/metrics` needs it |

### Templates

```json
{
  "licence-renewed": {
    "fromName": "Imani subscriptions",
    "subject": "Your {{plan}} plan is renewed",
    "text": "Hello {{name}},\n\nYour {{plan}} plan runs until {{until}}.\n{{#note}}\n{{note}}\n{{/note}}\nManage it: {{manageUrl}}",
    "fields": {
      "name": { "type": "line", "default": "there" },
      "plan": { "type": "line", "required": true },
      "until": { "type": "line", "required": true },
      "note": { "type": "text", "max": 500 },
      "manageUrl": { "type": "url", "required": true }
    }
  }
}
```

`{{field}}` inserts, `{{#field}}…{{/field}}` only when it has a value, `{{^field}}…{{/field}}` only
when it has none. Nothing else. Built-ins: `gift-claim`, `gift-receipt`, `gift-return-link`,
`gift-bounced`, `gift-expiring`, `gift-reminder` (`builtins.ts`). `gift-expiring` is the recipient's
"expires soon" reminder (#410 §6) and by decision G13 has no link field at all: it points to the
original claim email by date and subject.

## Tests

```
npx vitest run services/imani-mailer      # unit: templates, config, mailer, HTTP (no network)
npm run test:mailer-it                    # integration: real SMTP against Mailpit in Docker
```

The integration suite starts its own disposable Mailpit containers (never the shared local one)
and asserts on what Mailpit **stored**: plain SMTP delivery, header/recipient injection, link
policy, idempotency across concurrency and a restart, sandbox redirect, scopes, suppressions and
rate limits, deployment templates; STARTTLS + AUTH against a throwaway private CA (and refusal of
an unverifiable certificate, wrong or missing credentials, clear text); DKIM signatures verified
with `mailauth` (and a tampered copy failing); 4xx/5xx refusals via Mailpit Chaos, and a server
that is down.

## Local stack

`deploy/compose.override.yml` runs `mailpit` (inbox http://localhost:8025) and, with
`COMPOSE_PROFILES=mailer`, `imani-mailer` on :8095 sending through it. Build the image with
`docker build -f services/imani-mailer/Dockerfile -t imani-mailer:local .`, and put `MAILER_TOKEN`,
`MAILER_CLIENTS` and `MAILER_TAG_KEY` in `imani-deploy/.env.local`.
