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

import { createServer } from 'node:http'

import { tokenFor, FileCredentialStore } from './adapters'
import { confirmAll, CredentialConfirmer, retryUnconfirmed } from './confirmation'
import { readConfig, ConfigError, type IssuerConfig } from './config'
import type { Ports } from './discharge'
import { countPass, renderMetrics } from './metrics'
import { DEFAULT_OUTBOX_OPTIONS, DeliveryOutbox, FileOutboxStore, runDeliveryPass } from './outbox'
import { PurchasesApi, ReportLostError } from './purchasesApi'
import { sendSaleRecord } from './saleRecord'
import { CredentialVault } from './vault'
import { runPass, type WorkerDeps } from './worker'

/** Build the real ports from config. Exported so a test can see the wiring. */
export function portsFor(
  config: IssuerConfig,
  fetchImpl: typeof fetch = fetch,
  vault: CredentialVault = vaultFor(config),
  confirmer: CredentialConfirmer = new CredentialConfirmer(config.gatewayUrl, fetchImpl),
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
  }
}

function vaultFor(config: IssuerConfig): CredentialVault {
  return new CredentialVault(config.vaultKeyHex, new FileCredentialStore(config.credentialsPath))
}

export function depsFor(
  config: IssuerConfig,
  vault: CredentialVault = vaultFor(config),
  confirmer: CredentialConfirmer = new CredentialConfirmer(config.gatewayUrl),
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
    ports: portsFor(config, fetch, vault, confirmer),
    gatewayUrl: config.gatewayUrl,
    livemode: config.livemode,
    outbox: new DeliveryOutbox(new FileOutboxStore(config.outboxPath), {
      ...DEFAULT_OUTBOX_OPTIONS,
      maxAttempts: config.deliveryMaxAttempts,
      baseBackoffMs: config.deliveryBaseBackoffMs,
      now: () => Date.now(),
    }),
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
  const deps = depsFor(config, vault, confirmer)

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
