import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The NUT-18V encoder, loaded into this service.
 *
 * `shared/nut18v.js` is a classic script: an IIFE that ends by assigning
 * `window.NUT18V` and exports nothing. The app loads it for its side effect
 * from `main.tsx`; a Node service has no `window`, so it is evaluated in a VM
 * context with the globals it actually reaches and the result lifted out.
 *
 * ## Why not reimplement it
 *
 * Because the wire format is the contract. `vreqA` is CBOR in URL-safe base64
 * and must match `VoucherPaymentRequest.java` byte for byte — a request this
 * service encoded slightly differently would scan, look right, and be refused
 * by the gateway, or worse, be accepted with a field the payer did not intend.
 * One encoder, used by the app and the API, is the only version of this that
 * cannot drift.
 *
 * ## Why a VM rather than an import
 *
 * The file declares `const NUT18V = (function(){...})()` at top level and never
 * exports it. Importing it under Node's ESM loader yields an empty module and
 * throws only later, at the first call, three frames from the cause. The VM
 * makes the coupling explicit and keeps the file untouched — editing it to add
 * an export would mean the app and this service load different bytes, which is
 * exactly what this is avoiding.
 */

export interface Nut18v {
  generate(input: {
    amount: number
    unit: string
    issuerId: string
    description?: string | null
    singleUse?: boolean
    expiresAt?: number
  }): { paymentId: string; requestString: string; clickableUri: string }
  parse(request: string): Record<string, unknown>
  isExpired(request: unknown, nowSeconds?: number): boolean
}

const HERE = dirname(fileURLToPath(import.meta.url))

let cached: Nut18v | null = null

export function nut18v(): Nut18v {
  if (cached) return cached

  const source = readFileSync(join(HERE, '..', '..', 'shared', 'nut18v.js'), 'utf8')

  // Exactly the globals the script reaches, and no more. `crypto` is used for
  // the payment id; the text codecs and base64 helpers for the encoding. A
  // bare context would fail at the first call rather than at load, which is the
  // error that sends you looking in the wrong file.
  const context: Record<string, unknown> = {
    crypto,
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    console,
  }
  createContext(context)
  runInContext(`${source}\n;globalThis.__NUT18V = NUT18V;`, context)

  const loaded = context.__NUT18V as Nut18v | undefined
  if (!loaded?.generate) {
    throw new Error('shared/nut18v.js did not define NUT18V — the encoder cannot be loaded')
  }

  cached = loaded
  return loaded
}
