// Regenerate the free tier's sales threshold for every merchant currency (#506).
//
// Usage: npx tsx scripts/free-tier-amounts.mts [xrate-rates.json] [--force]
//
// A MAINTENANCE tool, run by hand or by .github/workflows/free-tier-amounts.yml (manual dispatch,
// which opens a PR for review). Nothing at runtime calls a rate feed:
// the amounts this writes are hard-coded in the catalog, so the wallet and gateway-customer always
// agree, and a stall's limit only moves when someone publishes a new catalog.
//
// The rule, the same for every currency:
//   - USD, EUR, GBP, CHF, CAD, AUD stay at 100 face (owner, #506 Q2).
//   - XOF and XAF are 65,000: 100 EUR at the fixed 655.957, rounded down.
//   - Every other code is 100 USD at today's rate, rounded DOWN to 2 significant figures, so the
//     threshold is a round number and never worth more than 100 USD.
//   - Minor units use the wallet's decimals (`currencyDecimals` in src/lib/format.ts): Intl's,
//     except IQD, which the wallet pins to ISO's 3. A test checks the two agree.
//
// The rates come from imani-xrate, the estate's own hand-set fiat table (owner decision "Option A"),
// the same numbers gateway-customer and gateway-core back vouchers with, so a threshold and the sats
// behind it agree. xrate is internal only and GitHub Actions cannot reach it, so this script never
// fetches anything: it reads an export of `GET /v1/rates`, by default the committed
// services/subscription/xrate-rates.json. To refresh, on the host:
//
//   curl -fsS -H "X-Service-Id: wallet-export" -H "X-Service-Token: $XRATE_SVC_TOKEN_WALLET_EXPORT" \
//     http://<imani-xrate>:8095/v1/rates | jq . > services/subscription/xrate-rates.json
//   npx tsx scripts/free-tier-amounts.mts
//
// (or imani-xrate's `scripts/set-rate.sh export`), and commit both: the export is reviewed in the
// same PR as the thresholds it produced, with its `version`.
// Writes packages/licence/src/freeTierAmounts.ts and the free tier of
// services/subscription/catalog.json, bumping the catalog's version, ONLY when an amount changed:
// a run on unchanged rates touches nothing, so the quarterly workflow opens no empty PR.
//
// Guards, because the quarterly workflow runs it unattended:
//   - a currency the feed stops quoting keeps its last amount (dropping it would take it out of the
//     onboarding picker and leave its stalls a free allowance of 0);
//   - a threshold that moves by more than MAX_MOVE since the last table aborts the whole run, as
//     a bad feed reading is likelier than a currency halving in a quarter. Pass --force to accept
//     it after checking the rate by hand.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseXrateExport } from './xrate-rates.mts'

const ROOT = join(import.meta.dirname, '..')
const TABLE = join(ROOT, 'packages/licence/src/freeTierAmounts.ts')
const CATALOG = join(ROOT, 'services/subscription/catalog.json')
const XRATE_EXPORT = join(ROOT, 'services/subscription/xrate-rates.json')

const AT_FACE = ['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD']
const EUR_PEGGED: Record<string, number> = { XOF: 65000, XAF: 65000 }
/** Codes Intl lists that no merchant should pick: units of account, withdrawn or replaced. */
const EXCLUDED = new Set(['XDR', 'XSU', 'CUC', 'KPW', 'SVC', 'HRK', 'SLL', 'ZWL'])
/** Where the wallet's decimals differ from Intl's (src/lib/format.ts `nonIsoDecimals`). */
const DECIMALS_OVERRIDE: Record<string, number> = { IQD: 3 }

const decimalsOf = (code: string): number =>
  DECIMALS_OVERRIDE[code] ??
  new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits!

/** Round down to 2 significant figures: 1,346.07 → 1,300; 0.311 → 0.31. */
function roundDown2(x: number): number {
  const step = 10 ** (Math.floor(Math.log10(x)) - 1)
  return Math.floor(x / step + 1e-9) * step
}

/** Largest accepted change in one threshold between two tables, as a fraction. */
const MAX_MOVE = 0.5

const args = process.argv.slice(2)
const force = args.includes('--force')
const source = args.find((a) => !a.startsWith('--')) ?? XRATE_EXPORT
const { rates, version: xrateVersion, asOf } = parseXrateExport(await readFile(source, 'utf8'))

const catalog = JSON.parse(await readFile(CATALOG, 'utf8'))
const previous: Record<string, number> = catalog.tiers.free.limits.sales.amounts

const amounts: Record<string, number> = {}
const unpriced: string[] = []
const kept: string[] = []
for (const code of Intl.supportedValuesOf('currency')) {
  if (EXCLUDED.has(code)) continue
  const major = AT_FACE.includes(code) ? 100 : EUR_PEGGED[code] ?? (rates[code] > 0 ? roundDown2(100 * rates[code]) : undefined)
  if (major !== undefined) amounts[code] = Math.round(major * 10 ** decimalsOf(code))
  else if (previous[code] !== undefined) {
    amounts[code] = previous[code]
    kept.push(code)
  } else unpriced.push(code)
}
for (const code of Object.keys(previous)) {
  // A code this runtime's Intl no longer lists stays too: removing one is a decision, not a refresh.
  if (amounts[code] === undefined) {
    amounts[code] = previous[code]
    kept.push(code)
  }
}
if (kept.length) console.warn(`no rate, kept the last amount: ${kept.join(' ')}`)
// Not offered at onboarding until priced: the picker only lists codes in the table.
if (unpriced.length) console.warn(`no rate, left out: ${unpriced.join(' ')}`)

const jumps = Object.entries(amounts)
  .filter(([code, minor]) => previous[code] !== undefined && Math.abs(minor / previous[code] - 1) > MAX_MOVE)
  .map(([code, minor]) => `${code} ${previous[code]} → ${minor}`)
if (jumps.length && !force) {
  console.error(`moved by more than ${MAX_MOVE * 100}%, check the rates and re-run with --force: ${jumps.join(', ')}`)
  process.exit(2)
}

const sorted = Object.fromEntries(Object.entries(amounts).sort(([a], [b]) => a.localeCompare(b)))
if (JSON.stringify(sorted) === JSON.stringify(previous)) {
  console.log(`${Object.keys(sorted).length} currencies, xrate v${xrateVersion} of ${asOf}: no amount changed, catalog stays v${catalog.version}`)
  process.exit(0)
}

const rows = Object.entries(sorted).map(([code, minor]) => `  ${code}: ${minor},`)
await writeFile(
  TABLE,
  `/**
 * The free tier's lifetime sales threshold in every merchant currency, in MINOR units (#506).
 *
 * Generated by scripts/free-tier-amounts.mts from imani-xrate's rates (version ${xrateVersion}, as of ${asOf}). Do not edit by hand: re-run the
 * script, which also writes services/subscription/catalog.json, so the bundled and published
 * catalogs carry the same numbers (a test fails if they differ).
 *
 * About 100 USD each, rounded down to 2 significant figures. USD, EUR, GBP, CHF, CAD and AUD are
 * 100 face; XOF and XAF are 100 EUR at the fixed 655.957, rounded down. The onboarding currency
 * picker offers exactly these codes, so no stall is created in a currency with no threshold.
 */
export const FREE_TIER_AMOUNTS: Readonly<Record<string, number>> = {
${rows.join('\n')}
}
`,
)

catalog.tiers.free.limits.sales.amounts = sorted
delete catalog.fx
catalog.version += 1
await writeFile(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`)

const changed = Object.entries(sorted).filter(([code, minor]) => previous[code] !== minor)
console.log(`${Object.keys(sorted).length} currencies, xrate v${xrateVersion} of ${asOf}, ${changed.length} changed, catalog v${catalog.version}`)

// For the quarterly workflow's PR: what moved, in major units, for a reviewer to sanity-check.
if (process.env.FREE_TIER_SUMMARY) {
  const major = (code: string, minor: number | undefined) =>
    minor === undefined ? 'new' : (minor / 10 ** decimalsOf(code)).toLocaleString('en')
  const lines = changed.map(([code, minor]) => `| ${code} | ${major(code, previous[code])} | ${major(code, minor)} |`)
  await writeFile(
    process.env.FREE_TIER_SUMMARY,
    [
      `imani-xrate rates, version ${xrateVersion}, as of ${asOf}. Catalog v${catalog.version - 1} → v${catalog.version}, ${changed.length} of ${Object.keys(sorted).length} currencies changed.`,
      '',
      '| Currency | Was | Now |',
      '| --- | --- | --- |',
      ...lines,
      ...(kept.length ? ['', `No rate, last amount kept: ${kept.join(' ')}`] : []),
      ...(unpriced.length ? ['', `No rate, not offered at onboarding: ${unpriced.join(' ')}`] : []),
      '',
    ].join('\n'),
  )
}
