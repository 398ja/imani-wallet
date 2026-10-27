/**
 * subscription.imani.casa, the service: sells tiers by card and issues licences (#407 §6, §7).
 *
 * Nothing here is read to GRANT a feature. A licence is a signed voucher the wallet verifies
 * offline (ADR 0007). This service only decides when one is owed and mints it, so if it is down,
 * every stall keeps what it already holds.
 *
 * Every value is read at boot and a missing one is fatal, for the reason `purchase-issuer/config.ts`
 * gives: a default turns a deployment mistake into a silent one.
 */

export interface SubscriptionConfig {
  /** Public origin the browser signs NIP-98 for, e.g. https://subscription.imani.casa. */
  publicOrigin: string
  /**
   * Path the site and API are mounted under on that origin, '' or e.g. '/subscription'. Mounted
   * under the WALLET's origin, the site can read the key the wallet stored (localStorage is per
   * origin), which is how a stall sent here from the wallet is already signed in.
   */
  basePath: string
  /** gateway-customer, for minting (`/api/v1/wallet/vouchers`) and delivery (`/api/v1/dm/tokens/send`). */
  walletUrl: string
  /** The edge secret gateway-customer trusts, as `sell-subscription.mjs` sends it. */
  edgeSecret: string
  /** Relay the gateway publishes the delivery DM to. */
  internalRelay: string
  /** The seller's nsec (`IMANI_SUBSCRIPTIONS_SELLER_NSEC`). Signs licences' warrants and the catalog. */
  sellerNsec: string
  stripeSecretKey: string
  stripeWebhookSecret: string
  /** Stripe Price ids per tier and term, e.g. `basic:monthly=price_123`. */
  prices: Readonly<Record<string, string>>
  /** Pubkeys allowed to issue hand grants. */
  adminPubkeys: readonly string[]
  /** Where the sales ledger lives. Must be on a persistent volume. */
  ledgerPath: string
  /** The catalog published to wallets, as JSON (snake_case, the shape `parseCatalog` reads). */
  catalogPath: string
  port: number
  /** Stripe Tax on checkout (#407 Q10). */
  automaticTax: boolean
}

export class ConfigError extends Error {}

export function readConfig(env: NodeJS.ProcessEnv = process.env): SubscriptionConfig {
  const need = (name: string): string => {
    const value = (env[name] ?? '').trim()
    if (!value) throw new ConfigError(`${name} is required`)
    return value
  }
  const prices: Record<string, string> = {}
  for (const pair of need('SUBSCRIPTION_PRICES').split(',')) {
    const [key, id] = pair.split('=').map((s) => s.trim())
    if (!/^[a-z]+:(monthly|annual)$/.test(key ?? '') || !/^price_[A-Za-z0-9]+$/.test(id ?? '')) {
      throw new ConfigError(`SUBSCRIPTION_PRICES entry '${pair}' must be tier:term=price_…`)
    }
    prices[key] = id
  }
  const admins = (env.SUBSCRIPTION_ADMIN_PUBKEYS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  for (const a of admins) if (!/^[0-9a-f]{64}$/.test(a)) throw new ConfigError(`admin pubkey '${a}' is not 64 hex`)

  const origin = need('SUBSCRIPTION_PUBLIC_ORIGIN').replace(/\/+$/, '')
  if (!/^https?:\/\/[^/]+$/.test(origin)) throw new ConfigError('SUBSCRIPTION_PUBLIC_ORIGIN must be an origin')

  const basePath = (env.SUBSCRIPTION_BASE_PATH ?? '').trim().replace(/\/+$/, '')
  if (basePath && !/^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(basePath)) throw new ConfigError('SUBSCRIPTION_BASE_PATH must look like /subscription')

  return {
    publicOrigin: origin,
    basePath,
    walletUrl: need('SUBSCRIPTION_WALLET_URL').replace(/\/+$/, ''),
    edgeSecret: need('EDGE_SECRET'),
    internalRelay: env.INTERNAL_RELAY_URL?.trim() || 'ws://nostr-relay:7777',
    sellerNsec: need('IMANI_SUBSCRIPTIONS_SELLER_NSEC'),
    stripeSecretKey: need('STRIPE_SECRET_KEY'),
    stripeWebhookSecret: need('STRIPE_WEBHOOK_SECRET'),
    prices,
    adminPubkeys: admins,
    ledgerPath: env.SUBSCRIPTION_LEDGER_PATH?.trim() || '/data/ledger.json',
    catalogPath: need('SUBSCRIPTION_CATALOG_PATH'),
    port: Number(env.PORT ?? 8090),
    automaticTax: (env.SUBSCRIPTION_AUTOMATIC_TAX ?? 'on').trim() !== 'off',
  }
}
