# OpenTelemetry in Imani Wallet

An investigation into what <https://opentelemetry.io> would add here, what it
would cost, and where it must not go. Written against what the repo does today,
not against the general case for observability.

## What we have today

Two Node services carry their own instrumentation, both hand-rolled:

- `services/audit-api/metrics.ts` — a careful, pre-registered Prometheus
  exposition. Closed label domains, zero-initialised series, gauges derived from
  the snapshot rather than accumulated. It is good work and it encodes hard-won
  rules (`add-a-metric.md`).
- `services/wallet-api/server.ts` — `/metrics` returns a **JSON blob** of
  counters plus guard stats. Not Prometheus exposition, so nothing can scrape it
  into the same dashboard as the audit API.

Beyond that: `console.log`/`console.error` for logs, no request ids, no trace
propagation, and `perf/` + `loadtest/` measure latency **from the outside** only.
`deploy/compose.override.yml` runs eleven services (mint, gateway core/portal/
customer, vault, relay, blossom, bottin, phoenixd) and none of them share a
correlation identifier with the wallet.

So the honest gap is not "we lack metrics". It is:

1. **wallet-api's metrics are a different shape from audit-api's**, so there is
   no single dashboard, and no alerting on the service that touches money.
2. **A slow or failed spend cannot be attributed.** A redemption crosses
   wallet-api → mint → gateway → relay. When `perf` shows p95 moving, nothing in
   the system says *which hop*. That is the question we currently cannot answer,
   and it is exactly the question tracing answers.
3. **Logs are unjoinable.** Eleven containers, no shared id, so an incident is
   reconstructed by timestamp and guesswork.

## What OpenTelemetry actually offers us

OTel is three things, and they are worth adopting at different urgencies.

### Traces — the real prize

One span per hop, propagated by W3C `traceparent` over the existing HTTP calls.
A spend becomes a single trace: plan → per-part delivery → gateway → mint →
relay publish. This gives us, for free from the data model:

- per-hop latency attribution, so a `perf` regression names its own cause
  (which is precisely the property `CONTEXT.md` demands of a *scenario*, but
  currently only achieved by isolating subsystems by hand);
- failure attribution for a **partial** spend, where one part fails
  independently and today produces an error with no trail;
- causal ordering across the async DM path (`dm-poll`, `voucher-send`), where
  timestamps alone genuinely cannot reconstruct order.

The Java services (vault, mint, gateway) can be instrumented with the OTel Java
**agent**, zero code change, which makes cross-team adoption cheap.

### Metrics — a consolidation, not a new capability

We would not gain much signal, but we would gain uniformity: one SDK, one
exporter, both services scraped alike, and the Prometheus exporter keeps the
existing dashboards working. The audit API's disciplines (pre-registration,
closed domains) survive the move intact — OTel supports both, but does **not**
enforce them, so `add-a-metric.md` stays the governing document, not the SDK.

Verdict: worth doing for `wallet-api`, which has no real exposition today. For
`audit-api`, migrating working, well-reasoned code is a low-value rewrite. Do it
only if and when we want exemplars linking metrics to traces.

### Logs — cheap win

Emitting logs through OTel stamps every line with the active trace id. That alone
converts eleven unjoinable log streams into one queryable incident view. Lower
effort than tracing, and most of the day-to-day incident value.

## Where it must not go

`docs/decentralised-posture.md` is not decoration; it constrains this decision.
Telemetry is a data collection programme, and the default OTel posture (collect
broadly, decide later) is the honeypot mindset applied to observability.

Firm rules for any adoption:

- **No client-side telemetry in the wallet app.** The browser/Capacitor app holds
  the customer's key and their coupons. A trace exporter there would build a
  central record of who spent what, when, and where — reconstructing the exact
  honeypot the design exists to avoid. If ever wanted, it must be explicit
  opt-in, off by default, and never carry identity.
- **Never as attributes**: npubs, pubkeys, nullifiers, coupon ids, face values,
  stall identity, IP addresses, request bodies. A nullifier in a span links a
  spend to a customer, permanently, in a system we do not control.
- **Safe attributes** are shapes, not values: part count, coupon count bucket,
  obstacle/refusal *reason* (already a closed domain in `guards.ts`), outcome
  code, hop name, duration.
- **Sampling and retention must be short and stated.** Traces are far heavier
  than counters; unbounded retention is unbounded liability.
- **Self-hosted collector only** (`otel-collector` in compose, alongside the
  relay), never a vendor SaaS endpoint. The collector is also the enforcement
  point: an attribute-drop processor as a second line of defence, so a careless
  span cannot exfiltrate a nullifier even if someone adds one.

## What I would actually do

Smallest thing that pays for itself, in order:

1. **Make `wallet-api` scrapeable.** Emit Prometheus exposition following the
   audit API's rules, so both services land on one dashboard and the money path
   becomes alertable. No OTel needed; do this regardless.
2. **Spike tracing on one flow only: a spend.** OTel Node SDK in `wallet-api`,
   HTTP instrumentation for propagation, self-hosted collector plus Jaeger or
   Tempo in `deploy/compose.override.yml`, off unless `OTEL_ENABLED=1`. Success
   criterion: run `loadtest/send.js`, then attribute p95 to a named hop. If it
   cannot do that, drop it.
3. **If the spike lands**, add the Java agent to the gateway and mint so the
   trace crosses the boundary, and route logs through OTel for trace ids.
4. **Wire `perf/` runs to emit a trace id per run**, so a baseline regression
   links to the trace that caused it. This is where OTel stops being ops
   plumbing and becomes a development tool for us.

Do **not**: migrate the audit API's metrics, instrument the client app, or turn
tracing on in production before the collector's redaction processor is tested.

## The honest counter-argument

We are a small system with a strong existing metrics culture and good
outside-in performance measurement. OTel brings a real dependency surface (SDK,
collector, backend storage), a new operational component to run, and a standing
temptation to collect more than we should. If the answer to "which hop is slow"
were already available, this would not be worth it.

It is not available, and that is the whole case.
