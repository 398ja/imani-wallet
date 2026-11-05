// Reading an imani-xrate `GET /v1/rates` export for scripts/free-tier-amounts.mts (#506).
//
// imani-xrate holds the estate's fiat rates (units per 1 USD), set by an operator. It is internal
// only, so this never fetches it: the export is taken on the host and committed (see the script).

export interface XrateTable {
  /** Units of each currency per 1 USD. */
  rates: Record<string, number>
  /** The table's version: it changes on every update. */
  version: number
  /** Newest `updated_at` in the table, YYYY-MM-DD. */
  asOf: string
}

/** Parses and checks an export. Throws on anything that is not a USD-based xrate table. */
export function parseXrateExport(text: string): XrateTable {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('the rates file is not JSON')
  }
  const b = body as { base?: unknown; version?: unknown; as_of?: unknown; rates?: unknown }
  if (!b || typeof b !== 'object') throw new Error('the rates file is not an object')
  if ('time_last_update_unix' in b) {
    throw new Error('this is an open.er-api.com response: export the rates from imani-xrate instead (GET /v1/rates)')
  }
  if (b.base !== 'USD') throw new Error(`not a USD-based imani-xrate export (base ${String(b.base)})`)
  if (typeof b.version !== 'number' || !Number.isInteger(b.version) || b.version < 1) {
    throw new Error('the export has no version')
  }
  if (typeof b.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(b.as_of)) throw new Error('the export has no as_of')
  if (!b.rates || typeof b.rates !== 'object' || Array.isArray(b.rates)) throw new Error('the export has no rates')
  const rates: Record<string, number> = {}
  for (const [code, entry] of Object.entries(b.rates as Record<string, unknown>)) {
    const v = (entry as { units_per_usd?: unknown } | null)?.units_per_usd
    if (!/^[A-Z]{3}$/.test(code) || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`bad rate for ${code}`)
    }
    rates[code] = v
  }
  if (rates.USD !== 1) throw new Error('the export does not quote USD at 1')
  return { rates, version: b.version, asOf: b.as_of.slice(0, 10) }
}
