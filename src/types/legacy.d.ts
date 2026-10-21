/**
 * imani-apps' unextracted `shared/*.js` modules.
 *
 * Imported for their side effect — each assigns itself onto `window` — so there
 * is nothing meaningful to type. Declaring them keeps `strict` on for our own
 * code instead of switching off `noImplicitAny` project-wide.
 */
declare module '*/shared/nut18v.js'

/**
 * The classic scripts are loaded via <script> tags, not imported — `?url` just
 * asks Vite for their served URL.
 */
declare module '*.js?url' {
  const url: string
  export default url
}

/**
 * currency.js is the exception — a real ES module with named exports, and the
 * one tokenRedemption prefers. Typed because we pass its functions on rather
 * than importing it purely for effect.
 */
declare module '*/shared/currency.js' {
  export const UNKNOWN: string
  export function normalizeFaceUnit(input: unknown): string | null
  export function resolveFaceUnit(inputs: unknown): { faceUnit: string; source: string }
}

/**
 * The seller's out-of-band subscription tool.
 *
 * A `.mjs` script rather than app source, because it runs under plain node with
 * no build step. It is imported by ONE test — the drift guard that asserts the
 * licence metadata it writes is byte-identical to `licenceIssue.ts`'s — and that
 * import is the point: the script restates a shape defined in TypeScript it
 * cannot import, and a restatement drifts silently.
 *
 * Only `licenceMetadata` is declared. The rest of the script mints and delivers
 * over the network and has no business being reachable from a test.
 */
declare module '*/scripts/sell-subscription.mjs' {
  /** The env var that holds the deployed seller's nsec (the deploy env file only). */
  export const SELLER_NSEC_VAR: 'IMANI_SUBSCRIPTIONS_SELLER_NSEC'
  /** The seller from IMANI_SUBSCRIPTIONS_SELLER_NSEC (env, or one line of `envFile`), or null. */
  export function sellerFromEnv(
    env?: Record<string, string | undefined>,
    envFile?: string,
  ): { name: string; sk: Uint8Array; pk: string } | null
  export function licenceMetadata(terms: {
    lockKey: string
    subscriptionId: string
    features: string[]
    pilot?: boolean
    paidAmountMinor: number
    paidCurrency: string
  }): string
  /** The issuance request for one licence: FIXED, with the seller's merchant warrant. */
  export function licenceIssueBody(
    seller: { pk: string; sk: string | Uint8Array },
    sale: { paidAmountMinor: number; paidCurrency: string; term: string; metadata: string },
  ): {
    face_value: number
    face_unit: string
    face_decimals: number
    backing_strategy: 'FIXED'
    issuer_id: string
    memo: string
    expires_in_days: number
    merchant_metadata: Record<string, unknown>
    issuance_warrant: string
  }
  /** imani-wallet#226: the seller's NIP-98 revocation of a subscription (a refund). */
  export function revokeRequest(
    seller: { pk: string; sk: Uint8Array | string },
    walletUrl: string,
    subscriptionId: string,
    reason?: string,
  ): { url: string; method: 'POST'; body: string; headers: Record<string, string> }
  /** Throws when the ledger records `subscriptionId` as revoked: a renewal under it grants nothing. */
  export function assertNotRevoked(rows: Array<{ subscription_id: string; revoked_at?: string | null }>, subscriptionId: string): void
  /** The sold-subscriptions ledger with `subscriptionId` marked revoked. */
  export function markRevoked<T extends { subscription_id: string }>(
    rows: T[],
    subscriptionId: string,
    revokedAt: string,
    reason?: string,
  ): Array<T & { revoked_at?: string; revoked_reason?: string; notices?: unknown[] }>
}

/**
 * The seller's expiry-notice sender.
 *
 * Declared for the same reason as `sell-subscription.mjs` above: it restates a
 * schedule defined in `src/lib/expiryNotice.ts` that a plain-node script cannot
 * import, and one test compares the two answers day by day so the pair cannot
 * drift into a customer being warned by one channel and not the other.
 */
declare module '*/scripts/notify-expiring.mjs' {
  /** The notice due today in whole days before expiry, or null for silence. */
  export function noticeDueOn(expiresAt: number, now: number): number | null
  export function noticeMessage(daysLeft: number, expiresAt: number): string
  /** False for a revoked (refunded) subscription: no reminders. */
  export function remindable(row: { subscription_id?: string; expires_at?: number | null; revoked_at?: string | null }): boolean
}
