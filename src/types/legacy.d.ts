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
