/**
 * The free-tier thresholds are computed from imani-xrate's rates (#506, Option A), the same table
 * gateway-customer and gateway-core back vouchers with. These pin the export format the script
 * accepts, and that the committed export still produces the committed thresholds.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { FREE_TIER_AMOUNTS } from '@imani/licence'

// Imported dynamically, like the other tests that load a script (licenceIssue, expiryNotice): the
// wallet image's .dockerignore leaves scripts/ out (it holds key-material tooling), and a static
// import made the image's `tsc -b` fail on a file that is not there. Vitest runs from the repo.
type Parse = (text: string) => { rates: Record<string, number>; version: number; asOf: string }
const parseXrateExport: Parse = (text) => parse(text)
let parse: Parse
beforeAll(async () => {
  const path = '../../../scripts/xrate-rates.mts'
  parse = ((await import(/* @vite-ignore */ path)) as { parseXrateExport: Parse }).parseXrateExport
})

const EXPORT = readFileSync(join(__dirname, '../../../services/subscription/xrate-rates.json'), 'utf8')

const table = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    base: 'USD',
    version: 7,
    as_of: '2026-11-04T00:02:31Z',
    rates: { USD: { units_per_usd: 1 }, NGN: { units_per_usd: 1346.069771 } },
    ...over,
  })

describe('reading an imani-xrate export', () => {
  it('reads units per dollar, the version and the date', () => {
    const t = parseXrateExport(table())
    expect(t.rates).toEqual({ USD: 1, NGN: 1346.069771 })
    expect(t.version).toBe(7)
    expect(t.asOf).toBe('2026-11-04')
  })

  it('refuses an open.er-api.com response, so the old feed cannot sneak back in', () => {
    expect(() => parseXrateExport(JSON.stringify({ result: 'success', time_last_update_unix: 1, rates: { USD: 1 } })))
      .toThrow(/open\.er-api/)
  })

  it('refuses a table not quoted per dollar, or without a version', () => {
    expect(() => parseXrateExport(table({ base: 'EUR' }))).toThrow(/USD-based/)
    expect(() => parseXrateExport(table({ rates: { USD: { units_per_usd: 0.9 } } }))).toThrow(/USD at 1/)
    expect(() => parseXrateExport(table({ version: undefined }))).toThrow(/version/)
    expect(() => parseXrateExport(table({ rates: undefined }))).toThrow(/rates/)
    expect(() => parseXrateExport(table({ rates: { USD: { units_per_usd: 1 }, NGN: { units_per_usd: -1 } } })))
      .toThrow(/NGN/)
    expect(() => parseXrateExport('not json')).toThrow(/JSON/)
  })

  it('the committed export covers every currency the free tier is priced in', () => {
    const t = parseXrateExport(EXPORT)
    expect(Object.keys(t.rates).sort()).toEqual(Object.keys(FREE_TIER_AMOUNTS).sort())
    // XOF and XAF sit at the 655.957 EUR peg in xrate.
    expect(t.rates.XOF / t.rates.EUR).toBeCloseTo(655.957, 6)
  })
})
