/**
 * What this worker needs before it may mint anything.
 *
 * Split out from the entrypoint so it can be TESTED, which matters more here
 * than the file count suggests. Every value below is read from the environment
 * of a container nobody watches, and the failure mode of getting one wrong is
 * not a crash — it is a worker that starts, polls a queue it cannot read, and
 * reports success while a customer who paid waits forever.
 *
 * ## Why this refuses to boot rather than degrading
 *
 * The tempting shape is a default for everything: an empty token, a localhost
 * gateway, `livemode` off. Each default turns a deployment mistake into a
 * SILENT one. An empty token gets 401 from the purchases API, whose `owed()`
 * deliberately returns `[]` on failure so a worker idles through an outage
 * instead of crash-looping — correct for an outage, and indistinguishable from
 * "nothing is owed" when the cause is a missing secret. The queue would look
 * empty and healthy while debts piled up behind it.
 *
 * So a missing value is fatal AT BOOT, where a deploy shows it, rather than
 * invisible at run time.
 *
 * ## `livemode` has no default at all
 *
 * `worker.ts` skips rows whose livemode does not match, so this flag decides
 * whether real coupons get minted for real payments. Defaulting it either way
 * picks a wrong answer for somebody: defaulting false leaves production debts
 * silently unworked, and defaulting true lets a test payment mint real value.
 * The deployment is the only thing that knows, so it must say.
 */

export interface IssuerConfig {
  /** Where the purchases API lives, e.g. http://payment-adapter:8080. */
  purchasesUrl: string
  /** The bearer token for it. */
  purchasesToken: string
  /** Where the gateway lives, for minting and delivering. */
  gatewayUrl: string
  /** 32 bytes of hex. Unseals the credential store; never stored beside it. */
  vaultKeyHex: string
  /** Where sealed credentials live on disk. */
  credentialsPath: string
  /** The durable delivery outbox (imani-wallet#274). Must be on a persistent volume. */
  outboxPath: string
  /** Deliveries before a coupon is parked `delivery_exhausted`. */
  deliveryMaxAttempts: number
  /** First retry delay; doubles per attempt, capped at an hour. */
  deliveryBaseBackoffMs: number
  /** Whether this deployment may mint real coupons. */
  livemode: boolean
  /** How long to sleep between passes. */
  intervalMs: number
  /** Liveness port. */
  port: number
  /**
   * The public origin a stall signs its enrolment NIP-98 for (imani-wallet#298), e.g.
   * https://wallet.example. Null leaves self-service enrolment OFF (503), never guessed from a
   * Host header: a signature is bound to one URL, and accepting any origin defeats that.
   */
  publicOrigin: string | null
  /**
   * Locked gift delivery (#410 G14), or null when this issuer does not deliver handle/email gifts
   * (they are then refused before minting). On only when `PURCHASE_GIFT_SEAL_KEY` is set, and then
   * every other value is REQUIRED: no defaults, a half-configured gift path refuses to boot.
   */
  gifts: {
    /** The key the gifting site seals ℓ to (payment-adapter's issuer-key is its public key). */
    sealKeyHex: string
    walletOrigin: string
    mailerUrl: string
    mailerToken: string
    /** Durable mint anchors for gift locktimes. */
    anchorsPath: string
    /** G15: durable tracked gifts for claimed/expired notices. */
    trackerPath: string
    /** Optional origin replacing the coupon's mint URL for NUT-07 (local stacks). */
    mintTransportUrl: string | null
    /** Per-gift re-check interval, or null for the default. */
    sweepEveryMs: number | null
    /** TEST MODE ONLY: the claim window in seconds instead of the draft's days. */
    testWindowSeconds: number | null
    /**
     * #410 code gifts: imani-checkout-codes, or null when `PURCHASE_CODE_GIFTS` is not `true` (the
     * default). Off, every code gift is parked before minting.
     */
    checkoutCodesUrl: string | null
  } | null
}

/** Refused at boot, naming everything that is wrong rather than the first thing. */
export class ConfigError extends Error {
  readonly missing: readonly string[]

  constructor(missing: readonly string[]) {
    super(`purchase-issuer cannot start; fix these and redeploy:\n  - ${missing.join('\n  - ')}`)
    this.name = 'ConfigError'
    this.missing = missing
  }
}

/**
 * Read the config, or explain everything that is wrong with it.
 *
 * Collects ALL the problems before throwing. Failing on the first one turns a
 * misconfigured deploy into a guessing game played one restart at a time, and
 * these values are usually wrong together — a stack that never set any of them
 * should be told that once.
 */
export function readConfig(env: NodeJS.ProcessEnv): IssuerConfig {
  const missing: string[] = []

  const purchasesUrl = (env.PURCHASE_API_URL ?? '').trim()
  if (purchasesUrl === '') {
    missing.push('PURCHASE_API_URL: where payment-adapter serves /api/v1/purchases')
  }

  const purchasesToken = (env.PURCHASE_API_TOKEN ?? '').trim()
  if (purchasesToken === '') {
    // Must match `purchase.api.token` on payment-adapter. A mismatch reads as
    // an empty queue, which is why this is fatal rather than defaulted.
    missing.push('PURCHASE_API_TOKEN: must equal payment-adapter’s purchase.api.token')
  }

  const gatewayUrl = (env.PURCHASE_GATEWAY_URL ?? '').trim()
  if (gatewayUrl === '') {
    missing.push('PURCHASE_GATEWAY_URL: the gateway that mints and delivers')
  }

  const vaultKeyHex = (env.PURCHASE_VAULT_KEY ?? '').trim()
  if (vaultKeyHex === '') {
    missing.push('PURCHASE_VAULT_KEY: 32 bytes of hex sealing the credential store')
  } else if (!/^[0-9a-f]{64}$/i.test(vaultKeyHex)) {
    // Checked HERE as well as in the vault, because the vault throws on first
    // use and this throws on boot. A key of the wrong length that only fails
    // when a sale arrives is a deployment that looks healthy until it matters.
    missing.push('PURCHASE_VAULT_KEY: must be exactly 64 hex characters')
  }

  const livemodeRaw = (env.PURCHASE_LIVEMODE ?? '').trim().toLowerCase()
  if (livemodeRaw !== 'true' && livemodeRaw !== 'false') {
    missing.push(
      'PURCHASE_LIVEMODE: must be exactly "true" or "false"; ' +
        'it decides whether real value is minted, so there is no safe default',
    )
  }

  let gifts: IssuerConfig['gifts'] = null
  const sealKeyHex = (env.PURCHASE_GIFT_SEAL_KEY ?? '').trim().toLowerCase()
  if (sealKeyHex !== '') {
    if (!/^[0-9a-f]{64}$/.test(sealKeyHex)) missing.push('PURCHASE_GIFT_SEAL_KEY: must be exactly 64 hex characters')
    const walletOrigin = origin(env.PURCHASE_WALLET_ORIGIN)
    if (walletOrigin === null) missing.push('PURCHASE_WALLET_ORIGIN: the wallet origin claim links point at (required with PURCHASE_GIFT_SEAL_KEY)')
    const mailerUrl = (env.PURCHASE_MAILER_URL ?? '').trim()
    if (mailerUrl === '') missing.push('PURCHASE_MAILER_URL: imani-mailer, for claim emails (required with PURCHASE_GIFT_SEAL_KEY)')
    const mailerToken = (env.PURCHASE_MAILER_TOKEN ?? '').trim()
    if (mailerToken === '') missing.push('PURCHASE_MAILER_TOKEN: imani-mailer bearer token (required with PURCHASE_GIFT_SEAL_KEY)')
    const anchorsPath = (env.PURCHASE_GIFT_ANCHORS_PATH ?? '').trim()
    if (anchorsPath === '') missing.push('PURCHASE_GIFT_ANCHORS_PATH: durable gift mint anchors, on a persistent volume')
    const trackerPath = (env.PURCHASE_GIFT_TRACKER_PATH ?? '').trim()
    if (trackerPath === '') missing.push('PURCHASE_GIFT_TRACKER_PATH: durable tracked gifts for claimed/expired notices, on a persistent volume')
    const rawTransport = (env.PURCHASE_MINT_TRANSPORT_URL ?? '').trim()
    let mintTransportUrl: string | null = null
    if (rawTransport !== '') {
      mintTransportUrl = origin(rawTransport) === null ? null : rawTransport.replace(/\/+$/, '')
      if (mintTransportUrl === null) missing.push('PURCHASE_MINT_TRANSPORT_URL: must be a URL')
    }
    // How often one gift is re-checked at the mint (default 10 min). A local stack sets it low to see
    // the claimed notice within a test; never below 5 s.
    const rawSweep = (env.PURCHASE_GIFT_SWEEP_MS ?? '').trim()
    const sweepEveryMs = rawSweep === '' ? null : Number(rawSweep)
    if (sweepEveryMs !== null && (!Number.isInteger(sweepEveryMs) || sweepEveryMs < 5_000)) {
      missing.push('PURCHASE_GIFT_SWEEP_MS: whole milliseconds, at least 5000')
    }
    // TEST MODE ONLY: a claim window in seconds, so an end-to-end test sees it end. Live mode
    // refuses to boot with it (a real buyer's recipient always gets the stall's window).
    const rawTestWindow = (env.PURCHASE_TEST_CLAIM_WINDOW_SECONDS ?? '').trim()
    let testWindowSeconds: number | null = null
    if (rawTestWindow !== '') {
      testWindowSeconds = Number(rawTestWindow)
      if (!Number.isInteger(testWindowSeconds) || testWindowSeconds < 30 || testWindowSeconds > 86_400) {
        missing.push('PURCHASE_TEST_CLAIM_WINDOW_SECONDS: whole seconds, 30 to 86400')
      } else if (livemodeRaw === 'true') {
        missing.push('PURCHASE_TEST_CLAIM_WINDOW_SECONDS: test mode only, never with PURCHASE_LIVEMODE=true')
      }
    }
    // #410 code gifts: off unless exactly `true`, and then the code store is REQUIRED.
    let checkoutCodesUrl: string | null = null
    const codeGifts = (env.PURCHASE_CODE_GIFTS ?? '').trim()
    if (codeGifts !== '' && codeGifts !== 'true' && codeGifts !== 'false') missing.push('PURCHASE_CODE_GIFTS: true or false')
    if (codeGifts === 'true') {
      const raw = (env.PURCHASE_CHECKOUT_CODES_URL ?? '').trim()
      checkoutCodesUrl = origin(raw) === null ? null : raw.replace(/\/+$/, '')
      if (checkoutCodesUrl === null) missing.push('PURCHASE_CHECKOUT_CODES_URL: imani-checkout-codes base URL (required with PURCHASE_CODE_GIFTS=true)')
    }
    gifts = { sealKeyHex, walletOrigin: walletOrigin ?? '', mailerUrl, mailerToken, anchorsPath, trackerPath, mintTransportUrl, sweepEveryMs, testWindowSeconds, checkoutCodesUrl }
  }

  if (missing.length > 0) throw new ConfigError(missing)

  const livemode = livemodeRaw === 'true'

  // Transport (imani-wallet#96). The owed feed decides how much real value is
  // minted and for whom, so in LIVE mode it must arrive over TLS: a plaintext
  // intra-cluster hop is answerable by any pod on the network. Test mode may
  // stay plaintext (local compose, staging with Stripe test keys), and a
  // deployment that terminates TLS in a sidecar (mTLS mesh) says so
  // explicitly, rather than by leaving the check off.
  const plaintextAllowed = (env.PURCHASE_API_ALLOW_PLAINTEXT ?? '').trim().toLowerCase() === 'true'
  if (livemode && !plaintextAllowed && !isHttps(purchasesUrl)) {
    throw new ConfigError([
      'PURCHASE_API_URL: must be https:// when PURCHASE_LIVEMODE=true; the owed feed decides ' +
        'what real value is minted. Set PURCHASE_API_ALLOW_PLAINTEXT=true only behind an mTLS sidecar',
    ])
  }

  return {
    purchasesUrl,
    purchasesToken,
    gatewayUrl,
    vaultKeyHex: vaultKeyHex.toLowerCase(),
    // A path CAN be defaulted: it names a location, not a secret or a mode, and
    // a wrong one fails loudly on the first read rather than silently.
    credentialsPath: (env.PURCHASE_CREDENTIALS_PATH ?? '/var/lib/imani/purchase-credentials.json').trim(),
    outboxPath: (env.PURCHASE_OUTBOX_PATH ?? '/var/lib/imani/purchase-outbox.json').trim(),
    deliveryMaxAttempts: positive(env.PURCHASE_DELIVERY_MAX_ATTEMPTS, 12),
    deliveryBaseBackoffMs: positive(env.PURCHASE_DELIVERY_BASE_BACKOFF_MS, 60_000),
    livemode,
    intervalMs: positive(env.PURCHASE_INTERVAL_MS, 15_000),
    port: positive(env.PURCHASE_ISSUER_PORT, 8791),
    publicOrigin: origin(env.PURCHASE_PUBLIC_ORIGIN),
    gifts,
  }
}

/** An origin with no path, or null when unset or unparseable. */
function origin(raw: string | undefined): string | null {
  const value = (raw ?? '').trim()
  if (value === '') return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

/** A parseable https URL. Anything else, including a typo, is not TLS. */
function isHttps(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * A positive number, or the default.
 *
 * `Number('')` is 0 and `Number('nonsense')` is NaN, and both would sail
 * through a bare `??`. A zero interval spins the loop as fast as the event
 * loop allows, hammering the gateway; a NaN port makes `listen` throw at boot
 * for a reason nobody would connect to the typo that caused it.
 */
function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}
