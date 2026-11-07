/**
 * Nothing secret leaves a run: every string that goes into a result, a report or a log passes
 * through `redact` first (#550). Pure and unit tested, including against the real-stall keys'
 * shapes (nsec bech32 and 64-hex).
 *
 * Rules:
 *  - registered secrets (the private keys this process holds, in nsec AND hex) -> [REDACTED]
 *  - any other nsec1… -> [REDACTED-NSEC]
 *  - 64-hex (pubkeys, event ids, private keys we were not told about) -> first 8 + …
 *  - checkout codes IMANI-XXXX-…, cashback codes CB-…, cashu tokens, vreq request strings,
 *    claim-link fragments (#k=…, /g#…) -> first 8 characters + …
 */

const registered = new Set<string>()

/** Tell the redactor about a secret this process holds. Both encodings, so neither can leak. */
export function registerSecret(...values: string[]): void {
  for (const v of values) if (v && v.length >= 16) registered.add(v)
}

export function clearSecrets(): void {
  registered.clear()
}

const keep8 = (m: string): string => `${m.slice(0, 8)}…`

const PATTERNS: [RegExp, (m: string) => string][] = [
  [/nsec1[02-9ac-hj-np-z]{20,}/gi, () => '[REDACTED-NSEC]'],
  [/IMANI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g, keep8],
  // The compact canonical form (checkoutCode.ts `IMANIXXXXXXXXXXXX`), which shops and fields that
  // allow no hyphens use. Missing it leaked whole codes for bart's shop into a report.
  [/\bIMANI[A-Z0-9]{12}\b/g, keep8],
  [/\bCB-[A-Z0-9]{4,5}-[A-Z0-9]{2,5}\b/g, keep8],
  [/cashu[AB][A-Za-z0-9_\-+/=]{16,}/g, keep8],
  [/\bvreq[A-Za-z0-9_\-+/=]{16,}/g, keep8],
  // Claim-link and gift-link fragments carry the claim key.
  [/#k=[^\s"'&|]+/g, () => '#k=…'],
  [/\/g#[^\s"'|]+/g, () => '/g#…'],
  [/\b[0-9a-f]{64}\b/gi, keep8],
]

export function redact(text: string): string {
  let out = String(text)
  for (const secret of registered) out = out.split(secret).join('[REDACTED]')
  for (const [re, fn] of PATTERNS) out = out.replace(re, fn)
  return out
}

/** Deep-redacts every string in a JSON-able value (keys too). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[redact(k)] = redactDeep(v)
    return out as T
  }
  return value
}
