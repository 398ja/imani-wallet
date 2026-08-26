import type { MerchantGroup } from '@imani/voucher-send'

/**
 * Render a face value in its own unit and decimals.
 *
 * Face values are minor units (cents), and `decimals` varies per merchant group
 * — zero-decimal currencies exist, which is why the divisor is not hardcoded.
 */
export function formatFace(
  minorUnits: number,
  group: Pick<MerchantGroup, 'unit' | 'decimals'> | undefined,
): string {
  const decimals = group?.decimals ?? 0
  const unit = group?.unit ?? ''
  const value = minorUnits / 10 ** decimals

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: unit,
      minimumFractionDigits: decimals,
    }).format(value)
  } catch {
    // `unit` is not always an ISO 4217 code (SAT, or a merchant's own unit).
    return `${value.toFixed(decimals)} ${unit}`.trim()
  }
}

/**
 * A sats amount, formatted the way imani-apps formats it.
 *
 * Mirrors `formatSats` in imani-apps' shared/format.js: floor, locale thousands
 * separators, no suffix — callers add the word. Sats are indivisible, so a
 * fractional value is a bug upstream and truncating is the honest render.
 *
 * `formatFace` cannot do this job. `formatFace(500, { unit: 'SAT', decimals: 0 })`
 * gives "SAT 500" — the ISO-currency path rejects SAT and the fallback puts the
 * unit last in the wrong vocabulary. Backing is a count, not a currency.
 */
export function formatSats(sats: number | undefined | null): string {
  if (sats === undefined || sats === null || !Number.isFinite(sats)) return ''
  return new Intl.NumberFormat(undefined).format(Math.floor(sats))
}

/**
 * Units whose decimals `Intl` gets wrong or refuses, resolved before we ask it.
 *
 * ONE list, shared by `currencyDecimals` (issuance) and `displayDecimals`
 * (rendering), because the two answering differently for the same unit is a
 * coupon whose label disagrees with its own backing.
 *
 *  - FCFA is not an ISO 4217 code at all. It is what merchants in the region
 *    actually type and it means XAF/XOF. `Intl` throws on it.
 *  - SAT/SATS/MSAT are our own denominations and have no minor unit.
 *  - BTC: `Intl` cheerfully answers 2, and `java.util.Currency` throws. Neither
 *    is what this system means by BTC, and gateway-portal's
 *    `CurrencyUnit.decimalsFor` already answers 0. Pinning it here keeps the
 *    three services from disagreeing about what one coupon is denominated in.
 *
 * Returns `undefined` when the unit is not an alias, so the caller can tell
 * "no opinion" from a genuine 0.
 */
function nonIsoDecimals(normalisedUnit: string): number | undefined {
  switch (normalisedUnit) {
    case 'FCFA':
    case 'SAT':
    case 'SATS':
    case 'MSAT':
    case 'BTC':
      return 0
    default:
      return undefined
  }
}

/**
 * Minor units per major unit for a currency, from `Intl` rather than a table so
 * the zero-decimal currencies in the issuance list (JPY, XOF, XAF) are right
 * without maintaining that list twice.
 *
 * This is the SATS-CORRECT answer, and that is why it is used for issuance even
 * though the gateway disagrees about the label. Backing runs at
 * `issuance_ratio: 1.0`, so one minor unit costs one sat: scaling 2500 XAF by
 * 100 instead of 1 asks the mint for 250,000 sats, which both over-backs the
 * coupon a hundredfold and makes the token too large to deliver — observed as a
 * flat `413` from the DM endpoint.
 *
 * The catch matters: a merchant may issue in a unit that is not an ISO 4217 code
 * at all, and `Intl` throws rather than guessing.
 *
 * FCFA and the sat denominations are resolved BEFORE Intl is asked, because
 * they are not ISO codes and would otherwise take the catch and return 2. That
 * is the worse half of the same bug `displayDecimals` had: this function feeds
 * ISSUANCE, so answering 2 for a zero-decimal unit does not merely misdraw a
 * label — it decides what the coupon is worth. FCFA is what merchants in the
 * region actually type and it means XAF/XOF.
 */
export function currencyDecimals(currency: string): number {
  const normalised = currency?.trim().toUpperCase() ?? ''
  const alias = nonIsoDecimals(normalised)
  if (alias !== undefined) return alias
  try {
    return (
      new Intl.NumberFormat(undefined, { style: 'currency', currency: normalised })
        .resolvedOptions().maximumFractionDigits ?? 2
    )
  } catch {
    return 2
  }
}

/**
 * How many decimals to DISPLAY a stored voucher row with.
 *
 * The row's own `face_decimals` is a fallback, not the source of truth, because
 * rows minted before the DEV-238 fix carry `face_decimals: 2` for every
 * currency including the zero-decimal ones. Trusting the row renders a real
 * 2,500 XAF coupon as "25.00" forever, and the fix at issuance only helps
 * coupons minted after it: every coupon already in a customer's wallet stays
 * wrong. The reviewer's point exactly — issuance was fixed, history was not.
 *
 * FCFA is handled explicitly because it is NOT an ISO 4217 code: it is what
 * merchants in the region actually type, and it means XAF/XOF. `Intl` throws on
 * it, which would send it down the fallback path and hand it straight back the
 * stale `2` this function exists to override — the exact "FCFA 0.02 for a 2
 * FCFA payment" defect, surviving the fix meant to kill it. Caught by checking
 * the shipped resolver against real staging rows rather than trusting the ISO
 * codes alone. gateway-portal's CurrencyUnit.decimalsFor carries the same alias
 * for the same reason.
 *
 * So the currency wins where we recognise it. `currencyDecimals` asks Intl,
 * which knows XAF/XOF/JPY take no minor unit, and only when the unit is absent
 * or non-ISO (a merchant's own "BEANS") do we fall back to what the row
 * recorded, because there we have no better answer than theirs.
 *
 * DISPLAY ONLY. The minor-unit integer is never rescaled — see
 * `currencyDecimals` above for why rescaling it is the one thing that must
 * never happen here. This changes the decimal point, never the money.
 */
export function displayDecimals(
  unit: string | undefined | null,
  storedDecimals: number | undefined | null,
): number {
  const fallback =
    typeof storedDecimals === 'number' && Number.isFinite(storedDecimals) && storedDecimals >= 0
      ? storedDecimals
      : 0
  if (!unit) return fallback
  const normalised = unit.trim().toUpperCase()
  const alias = nonIsoDecimals(normalised)
  if (alias !== undefined) return alias
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: normalised })
      .resolvedOptions().maximumFractionDigits ?? fallback
  } catch {
    // Not an ISO code — a merchant's own unit. Their record is the best answer.
    return fallback
  }
}

/**
 * A typed amount, as minor units. Returns null when it is not a number.
 *
 * Accepts both separators because the decimal mark is a comma across most of the
 * markets in the issuance currency list, and a phone keypad offers whichever the
 * device locale prefers. Rejecting "1,50" from a French merchant would be a bug,
 * not validation.
 *
 * Rounds rather than truncates: `Math.round` on the scaled value, because
 * floating point makes `1.15 * 100` land on 114.99999999999999 and truncation
 * would silently undercharge by a cent.
 */
export function parseAmountToMinor(input: string, decimals: number): number | null {
  const cleaned = input.trim().replace(/\s/g, '').replace(',', '.')
  if (cleaned === '' || !/^\d*\.?\d*$/.test(cleaned)) return null

  const value = Number(cleaned)
  if (!Number.isFinite(value) || value <= 0) return null

  return Math.round(value * 10 ** decimals)
}

/**
 * A NIP-05 as it is READ: `@song`, the local part with the domain dropped.
 *
 * Every account on a deployment shares the domain, so it is the half that
 * identifies nobody, and `song@staging.398ja.xyz` under a name reads as an email
 * address rather than as who you are. This is the one form the wallet shows,
 * everywhere it names a person.
 *
 * Display ONLY, and the one exception proves it: the Receive QR encodes the full
 * `name@domain` under a label rendered by this function, because resolution is a
 * fetch against the domain and the local part alone addresses nobody. Anything
 * machine-readable — `toRecipientPubkey`, the claim request, the stored kind-0 —
 * keeps both halves.
 */
export function handleLabel(nip05: string): string {
  return `@${nip05.split('@')[0]}`
}

/** Short form of a pubkey for display. */
export function shortPubkey(pubkey: string): string {
  return pubkey.length > 16 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}` : pubkey
}

/**
 * Any timestamp the wallet stores, as epoch milliseconds.
 *
 * Takes epoch milliseconds, epoch seconds, or an ISO string, because the wallet
 * stores all three: `VoucherRow.created_at` is ISO, transaction `timestamp` is
 * milliseconds in practice despite being documented as seconds, and
 * `expires_at` is BOTH — typed as epoch seconds, but the writer
 * (`shared/tokenRedemption.js` `_persistRedeemed`) stores the ISO string
 * `/inspect` returned. Reading only the declared type made `expires_at * 1000`
 * NaN, so a coupon with a real expiry sorted as expired and disappeared.
 * The magnitude test is the same one `toTransaction` uses — below 1e11 can only
 * be seconds.
 *
 * Absent, null, '' and 0 all collapse to undefined: for an expiry they mean "no
 * expiry" (the gateway populates the field asynchronously — see `toVoucher`),
 * and no other caller has a meaningful use for the epoch itself.
 */
export function toEpochMs(value: number | string | undefined | null): number | undefined {
  if (value === undefined || value === null || value === '' || value === 0) return undefined

  const ms =
    typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * A date and time the way the device would write it.
 *
 * The clock time is here rather than in a detail-screen-only variant: two
 * coupons received the same day are told apart by the minute, and a list that
 * hides it makes the reader open both.
 *
 * Returns '' for absent or unparseable input so callers can omit the row rather
 * than print "Invalid Date".
 */
export function formatDate(value: number | string | undefined | null): string {
  const ms = toEpochMs(value)
  if (ms === undefined) return ''

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms))
}

