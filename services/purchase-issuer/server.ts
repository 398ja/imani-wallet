/**
 * The purchase issuer, as a process.
 *
 * `worker.ts` is one pass over the queue and knows nothing about time,
 * signals or ports. This wraps it in the smallest thing that can be deployed:
 * a loop, a liveness endpoint, and a clean shutdown.
 *
 *   docker build -f services/purchase-issuer/Dockerfile -t imani-purchase-issuer .
 *
 * ## Why a poll loop and not a webhook
 *
 * `payment-adapter` already has the webhook. It records the debt
 * transactionally with Stripe's event and stops there, and ADR 0010 is
 * explicit that a payment is recorded BEFORE anything is issued so that a
 * failure leaves a recoverable debt rather than a lost sale. A push from the
 * webhook into this service would put minting back on the payment path — the
 * exact coupling that decision removed — and would need its own retry, its own
 * queue and its own idempotency, all of which the debt table already is.
 *
 * Polling costs a query every fifteen seconds and makes the recovery path and
 * the normal path THE SAME CODE. A missed push is a bug; a missed poll is the
 * next poll.
 *
 * ## More than one instance is now safe
 *
 * Each purchase is CLAIMED in payment-adapter before it is minted (one
 * conditional update, so exactly one worker wins), and every mint for a
 * purchase carries the same `Idempotency-Key` (imani-wallet#96). Replicas no
 * longer race; a dead worker's claim lapses and is taken over under the same
 * key.
 *
 * ## It halts rather than guess
 *
 * If the outcome of a mint cannot be recorded after every retry, the loop
 * STOPS and `/health` answers 503 with the reason. Carrying on would poll a
 * queue this worker can no longer keep honest, which is how one payment
 * becomes two coupons. A person restarts it once payment-adapter is back.
 */

import { createServer, type IncomingMessage } from 'node:http'

import { tokenFor, FileCredentialStore } from './adapters'
import { confirmAll, CredentialConfirmer, retryUnconfirmed } from './confirmation'
import { readConfig, ConfigError, type IssuerConfig } from './config'
import type { Ports } from './discharge'
import { fileAnchors, httpPublishEvent, httpQueryWraps, httpScrub, httpStallName, type GiftPorts } from './giftDelivery'
import { mailerClient } from '../imani-mailer/client.ts'
import { countPass, renderMetrics } from './metrics'
import { DEFAULT_OUTBOX_OPTIONS, DeliveryOutbox, FileOutboxStore, runDeliveryPass } from './outbox'
import { PurchasesApi, ReportLostError } from './purchasesApi'
import { sendSaleRecord } from './saleRecord'
import { ENROLMENT_PREFIX, EnrolmentService, MAX_BODY_BYTES } from './enrolment'
import { cachedValidityReader, readStallValidity, type ValidityReader } from './stallValidity'
import { CredentialVault } from './vault'
import { fileTrackerStore, GiftTracker, httpCheckStates } from './giftTracker'
import { runPass, type WorkerDeps } from './worker'

/** Build the real ports from config. Exported so a test can see the wiring. */
export function portsFor(
  config: IssuerConfig,
  fetchImpl: typeof fetch = fetch,
  vault: CredentialVault = vaultFor(config),
  confirmer: CredentialConfirmer = new CredentialConfirmer(config.gatewayUrl, fetchImpl),
  validityFor: ValidityReader = validityReaderFor(config, fetchImpl),
): Ports {
  // Credentials are confirmed EAGERLY, at enrolment and at startup (`confirmAll`, #296). This is
  // the backstop for one written while the service runs or one the gateway was down for at boot.
  // The confirmer sends one request per credential at a time and remembers the answer, and an
  // expired credential comes back marked so the sale fails fast with the real reason.
  return {
    credentialFor: async (stallPubkey) => {
      const credential = await vault.get(stallPubkey)
      return credential ? confirmer.annotate(credential) : null
    },
    tokenFor: (credential, voucherId) => tokenFor(config.gatewayUrl, credential, voucherId),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // #275: card sales into the stall's ledger. Tried inline once; the outbox owns retries (#274).
    fileSale: (credential, sale) => sendSaleRecord(config.gatewayUrl, credential, sale, fetchImpl),
    // #312: the stall's own term, from its signed merchant record, cached for minutes.
    validityFor,
    // #410 G14: locked gift delivery, only when configured (handle/email gifts refused otherwise).
    ...(config.gifts ? { gifts: giftPortsFor(config, config.gifts, fetchImpl) } : {}),
  }
}

function giftPortsFor(config: IssuerConfig, g: NonNullable<IssuerConfig['gifts']>, fetchImpl: typeof fetch): GiftPorts {
  const mailer = mailerClient({ baseUrl: g.mailerUrl, token: g.mailerToken, fetchImpl })
  return {
    sealSecretHex: g.sealKeyHex,
    walletOrigin: g.walletOrigin,
    testWindowSeconds: g.testWindowSeconds,
    publishEvent: httpPublishEvent(config.gatewayUrl, fetchImpl),
    queryWraps: httpQueryWraps(config.gatewayUrl, fetchImpl),
    sendMail: (req) => mailer.send(req),
    scrubSeal: httpScrub(config.purchasesUrl, config.purchasesToken, fetchImpl),
    anchor: fileAnchors(g.anchorsPath),
    stallName: httpStallName(config.gatewayUrl, fetchImpl),
    track: (input, mintUrl) => giftTrackerFor(config, fetchImpl).track(input, mintUrl),
  }
}

/** One tracker per config, shared by discharge (track) and the worker loop (sweep). */
const trackers = new WeakMap<IssuerConfig, GiftTracker>()
export function giftTrackerFor(config: IssuerConfig, fetchImpl: typeof fetch = fetch): GiftTracker {
  const g = config.gifts!
  let t = trackers.get(config)
  if (!t) {
    const mailer = mailerClient({ baseUrl: g.mailerUrl, token: g.mailerToken, fetchImpl })
    t = new GiftTracker(config.vaultKeyHex, fileTrackerStore(g.trackerPath), {
      checkStates: httpCheckStates(g.mintTransportUrl, fetchImpl),
      sendMail: (req) => mailer.send(req),
      now: () => Date.now(),
      ...(g.sweepEveryMs ? { sweepEveryMs: g.sweepEveryMs } : {}),
    })
    trackers.set(config, t)
  }
  return t
}

/** The stall-validity reader, one per process so the mint and `/ready` share its cache (#312). */
export function validityReaderFor(config: IssuerConfig, fetchImpl: typeof fetch = fetch): ValidityReader {
  return cachedValidityReader((stall) => readStallValidity(config.gatewayUrl, stall, fetchImpl))
}

function vaultFor(config: IssuerConfig): CredentialVault {
  return new CredentialVault(config.vaultKeyHex, new FileCredentialStore(config.credentialsPath))
}

export function depsFor(
  config: IssuerConfig,
  vault: CredentialVault = vaultFor(config),
  confirmer: CredentialConfirmer = new CredentialConfirmer(config.gatewayUrl),
  validityFor: ValidityReader = validityReaderFor(config),
): WorkerDeps {
  return {
    api: new PurchasesApi(config.purchasesUrl, config.purchasesToken, fetch, (row) => {
      // IW-07: a refused debt row must be loud. It means either the upstream is emitting
      // malformed data or somebody is trying to mint from a response they control, and both
      // need a human. The row's own fields are not logged: an attacker-supplied row is
      // attacker-supplied log content.
      console.warn(
        JSON.stringify({
          event: 'purchase_row_rejected',
          reason: 'failed_validation',
          detail: 'row dropped rather than minted from; see IW-07',
          row_type: row === null ? 'null' : Array.isArray(row) ? 'array' : typeof row,
        }),
      )
    }),
    ports: portsFor(config, fetch, vault, confirmer, validityFor),
    gatewayUrl: config.gatewayUrl,
    livemode: config.livemode,
    outbox: new DeliveryOutbox(new FileOutboxStore(config.outboxPath), {
      ...DEFAULT_OUTBOX_OPTIONS,
      maxAttempts: config.deliveryMaxAttempts,
      baseBackoffMs: config.deliveryBaseBackoffMs,
      now: () => Date.now(),
    }),
    ...(config.gifts ? { giftTracker: giftTrackerFor(config) } : {}),
  }
}

/**
 * What the last pass did, for the liveness endpoint.
 *
 * Reported rather than judged. A pass that discharges nothing is the normal
 * state of a quiet stall, so "no work" must never read as unhealthy — the
 * audit API's health check carries the same warning about failing a probe for
 * something that is not a fault.
 */
interface LastPass {
  at: number
  discharged: number
  deferred: number
  blocked: number
  skipped: number
  error?: string
}

let lastPass: LastPass | null = null
let running = true
/**
 * Why the loop stopped itself, when it did (imani-wallet#96). Set once; only
 * a restart clears it.
 */
let halted: string | null = null

/**
 * The loop.
 *
 * Never throws out of a pass. A debt that cannot be worked is left standing —
 * which is the recoverable state the whole design aims for — and a crash here
 * would stop every OTHER debt from being worked too.
 */
export async function loop(deps: WorkerDeps, intervalMs: number): Promise<void> {
  while (running) {
    try {
      const result = await runPass(deps)
      // Then the outbox (imani-wallet#274): coupons that exist and still owe a delivery or a
      // sale record. A store that cannot be read throws here, and the pass is reported failed.
      if (deps.outbox) {
        const delivery = await runDeliveryPass({
          outbox: deps.outbox,
          api: deps.api,
          ports: deps.ports,
          gatewayUrl: deps.gatewayUrl,
          workerId: deps.workerId,
        })
        if (delivery.delivered > 0 || delivery.exhausted > 0) {
          console.log(
            `[purchase-issuer] outbox delivered ${delivery.delivered}, exhausted ${delivery.exhausted}, ` +
              `retrying ${delivery.retried}, sales filed ${delivery.salesFiled}`,
          )
        }
      }
      lastPass = { at: Date.now(), ...result }
      countPass('ok')
      if (result.discharged > 0 || result.blocked > 0) {
        // Quiet on the ordinary case, loud on the two that matter. A line per
        // pass would be 5,760 lines a day saying nothing happened, and
        // `imani-woo` ADR 0008 is explicit that warning on every sale trains
        // an operator to stop reading.
        console.log(
          `[purchase-issuer] discharged ${result.discharged}, blocked ${result.blocked}, ` +
            `deferred ${result.deferred}, skipped ${result.skipped}`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastPass = { at: Date.now(), discharged: 0, deferred: 0, blocked: 0, skipped: 0, error: message }
      if (error instanceof ReportLostError) {
        // Fail closed (imani-wallet#96). Loud, structured, and the loop stops.
        halted = message
        running = false
        countPass('halted')
        console.error(
          JSON.stringify({
            event: 'purchase_issuer_halted',
            reason: 'failure_report_lost',
            event_id: error.eventId,
            voucher_id: error.voucherId ?? null,
            detail: message,
          }),
        )
        return
      }
      // Recorded on the health endpoint as well as logged, so a persistently
      // failing pass is visible to a probe rather than only to whoever reads
      // container output.
      countPass('failed')
      console.error('[purchase-issuer] pass failed', error)
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Test seam: the halt state, and a way to reset module state between tests. */
export function haltReason(): string | null {
  return halted
}
export function resetForTest(): void {
  halted = null
  running = true
  lastPass = null
}

/**
 * Self-service card-sales enrolment (imani-wallet#298), mounted by `main()` with the SAME vault
 * and confirmer the worker uses, so a stall enrolled here is minted for on the next pass.
 */
let enrolment: EnrolmentService | null = null
export function mountEnrolment(service: EnrolmentService | null): void {
  enrolment = service
}

/** The body, or null when it is larger than any enrolment request could be. */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Liveness only, and it does NOT report the queue.
 *
 * Two reasons. A probe that fails when the gateway is down would restart a
 * process whose whole job is to keep retrying through exactly that outage. And
 * the debt count is a business fact about money owed, on an endpoint with no
 * authentication; the health check is for the orchestrator, not a dashboard.
 */
export const server = createServer((req, res) => {
  if (req.url === '/health') {
    // Halted is the ONE state that fails the probe (imani-wallet#96): a
    // worker that stopped itself to avoid a double mint must be seen, and a
    // restart is the intended recovery once the purchases API is back.
    if (halted !== null) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'halted', reason: halted, lastPass }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', lastPass }))
    return
  }
  if (req.url === '/metrics') {
    // Counts by closed outcome only (imani-deploy#210): no id, stall or amount.
    // Scraped on the internal network; the edge does not route here.
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
    res.end(renderMetrics())
    return
  }
  if (enrolment !== null && (req.url ?? '').startsWith(ENROLMENT_PREFIX + '/')) {
    const service = enrolment
    // `.catch`, review of #302: a client that drops mid-body makes `for await` reject ("aborted"),
    // and an unhandled rejection takes the whole purchase issuer down, mid-pass, for everyone. A
    // public endpoint must not be one TCP reset away from stopping every stall's card sales.
    void readBody(req)
      .then(async (body) => {
        const answer =
          body === null
            ? { status: 413, body: { error: 'request too large' } }
            : await service.handle({
                method: req.method ?? 'GET',
                path: req.url ?? '',
                authorization: req.headers.authorization,
                body,
              })
        res.writeHead(answer.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(answer.body))
      })
      .catch(() => {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'the request did not arrive whole' }))
        }
      })
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

function main(): void {
  let config: IssuerConfig
  try {
    config = readConfig(process.env)
  } catch (error) {
    if (error instanceof ConfigError) {
      // The whole list, then exit. A container that restarts forever printing
      // one missing variable at a time is how a ten-minute fix becomes an
      // afternoon.
      console.error(error.message)
      process.exit(78) // EX_CONFIG, so a supervisor can tell this from a crash.
    }
    throw error
  }

  const vault = vaultFor(config)
  const confirmer = new CredentialConfirmer(config.gatewayUrl)
  const validityFor = validityReaderFor(config)
  const deps = depsFor(config, vault, confirmer, validityFor)
  mountEnrolment(new EnrolmentService({ vault, confirmer, publicOrigin: config.publicOrigin, validityFor }))
  // #290: a record sealed by somebody else (the operator script) is picked up on the next read,
  // and confirmed at once (#296) rather than at its first sale. One the gateway could not confirm
  // then is retried like a boot-time one (second review of #299). A new reload REPLACES the reload
  // retry rather than adding one, so a file that keeps changing never stacks timers, and each
  // retry stays bounded to the 24 h confirm window.
  let stopRetry: (() => void) | null = null
  vault.onReload(
    () =>
      void confirmAll(vault, confirmer).then((summary) => {
        if (summary.unconfirmed === 0) return
        stopRetry?.()
        stopRetry = retryUnconfirmed(vault, confirmer, () => running)
      }),
  )
  if (config.publicOrigin === null) {
    console.warn('[purchase-issuer] PURCHASE_PUBLIC_ORIGIN unset: self-service card-sales enrolment is OFF')
  }

  server.listen(config.port, () => {
    console.log(
      `[purchase-issuer] listening on ${config.port}, ` +
        `working ${config.livemode ? 'LIVE' : 'test'} purchases every ${config.intervalMs}ms`,
    )
  })

  // Confirm every held credential BEFORE the first pass (imani-wallet#296). The gateway lapses
  // one left unconfirmed for 24 h, so waiting for its first sale is how a quiet stall dies.
  void confirmAll(vault, confirmer).then((summary) => {
    console.log(
      `[purchase-issuer] credentials: ${summary.confirmed} confirmed, ` +
        `${summary.expired} expired (re-enrol), ${summary.unconfirmed} not yet confirmed`,
    )
    // Review of #299: one the gateway was down for at boot is retried every 5 min, for at most
    // the 24 h confirm window, rather than waiting for its first sale.
    if (summary.unconfirmed > 0) retryUnconfirmed(vault, confirmer, () => running)
    return loop(deps, config.intervalMs)
  })

  // A pass in flight is minting or delivering somebody's coupon. Stopping the
  // LOOP rather than the process lets it finish: `docker stop` sends SIGTERM
  // and waits, and killing mid-delivery is how a coupon ends up issued and
  // undelivered for no reason at all.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`[purchase-issuer] ${signal}; finishing the current pass`)
      running = false
      server.close()
    })
  }
}

// `import.meta.url` guard so tests can import this without binding a port or
// requiring the environment, matching audit-api's entrypoint.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main()
}
