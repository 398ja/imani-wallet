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
  export function licenceMetadata(terms: {
    lockKey: string
    subscriptionId: string
    features: string[]
    pilot?: boolean
    paidAmountMinor: number
    paidCurrency: string
  }): string
}
