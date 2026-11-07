/**
 * Money conservation for a real day (#550). Pure: the runner feeds it what the app SHOWED.
 *
 * Every persona's balance is read off the screen before the day and after it. Every journey that
 * moved money records what it moved. Afterwards, for every persona,
 *
 *     observed (after - before) == expected (sum of the movements naming it)
 *
 * and, over everyone, the total change equals sales + Cashlinks claimed - paid to the issuing
 * stall (burnt) - checkout codes made (locked out of the wallet, then spent at the shop).
 * A mismatch fails the run and names the personas.
 *
 * A stall's balance here is what it HOLDS OF ITS OWN coupons (its merchant page's BALANCE). A
 * payment to the issuer is received and burnt, so the expected change for a stall is zero; a
 * non-zero change is coupons that arrived and were not burnt.
 */

export type Movement =
  /** A stall sold `minor` to a customer: new money in the customer's wallet. */
  | { kind: 'sale'; stall: string; to: string; minor: number; unit: string }
  /** A customer claimed a stall's Cashlink: new money. */
  | { kind: 'cashlink'; stall: string; to: string; minor: number; unit: string }
  /** A customer paid the issuing stall: leaves the customer, burnt at the stall. */
  | { kind: 'pay'; from: string; stall: string; minor: number; unit: string }
  /** Customer to customer. */
  | { kind: 'send'; from: string; to: string; minor: number; unit: string }
  /** Sent as a Cashlink: leaves the sender now, arrives when `link-claim` is recorded. */
  | { kind: 'link-send'; from: string; minor: number; unit: string }
  | { kind: 'link-claim'; to: string; minor: number; unit: string }
  /** A checkout code locks `minor` out of the wallet; the shop spends it. */
  | { kind: 'code'; from: string; minor: number; unit: string }

export type Balances = Record<string, Record<string, number>>

function add(map: Balances, persona: string, unit: string, minor: number): void {
  const row = (map[persona] ??= {})
  row[unit] = (row[unit] ?? 0) + minor
}

export function expectedDeltas(movements: Movement[]): Balances {
  const out: Balances = {}
  for (const m of movements) {
    switch (m.kind) {
      case 'sale':
      case 'cashlink':
        add(out, m.to, m.unit, m.minor)
        break
      case 'pay':
        add(out, m.from, m.unit, -m.minor)
        add(out, m.stall, m.unit, 0)
        break
      case 'send':
        add(out, m.from, m.unit, -m.minor)
        add(out, m.to, m.unit, m.minor)
        break
      case 'link-send':
      case 'code':
        add(out, m.from, m.unit, -m.minor)
        break
      case 'link-claim':
        add(out, m.to, m.unit, m.minor)
        break
    }
  }
  return out
}

export type Mismatch = { persona: string; unit: string; before: number; after: number; observed: number; expected: number }

export type Conservation = {
  ok: boolean
  mismatches: Mismatch[]
  /** Personas whose balance could not be read before or after: a failure, not a pass. */
  unread: string[]
  totals: Record<string, { observed: number; expected: number; issued: number; burnt: number; outstandingLinks: number }>
}

/** NaN-free, unit-wise difference. A persona absent from `before` or `after` is unread. */
export function conserve(before: Balances, after: Balances, movements: Movement[]): Conservation {
  const expected = expectedDeltas(movements)
  const personas = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(expected)])
  const mismatches: Mismatch[] = []
  const unread: string[] = []
  const totals: Conservation['totals'] = {}
  const total = (unit: string) => (totals[unit] ??= { observed: 0, expected: 0, issued: 0, burnt: 0, outstandingLinks: 0 })

  for (const persona of [...personas].sort()) {
    const b = before[persona]
    const a = after[persona]
    if (!b || !a || Object.values({ ...b, ...a }).some((v) => !Number.isFinite(v))) {
      unread.push(persona)
      continue
    }
    const units = new Set([...Object.keys(b), ...Object.keys(a), ...Object.keys(expected[persona] ?? {})])
    for (const unit of units) {
      const observed = (a[unit] ?? 0) - (b[unit] ?? 0)
      const want = expected[persona]?.[unit] ?? 0
      total(unit).observed += observed
      total(unit).expected += want
      if (observed !== want) mismatches.push({ persona, unit, before: b[unit] ?? 0, after: a[unit] ?? 0, observed, expected: want })
    }
  }
  for (const m of movements) {
    if (m.kind === 'sale' || m.kind === 'cashlink') total(m.unit).issued += m.minor
    if (m.kind === 'pay' || m.kind === 'code') total(m.unit).burnt += m.minor
    if (m.kind === 'link-send') total(m.unit).outstandingLinks += m.minor
    if (m.kind === 'link-claim') total(m.unit).outstandingLinks -= m.minor
  }
  return { ok: mismatches.length === 0 && unread.length === 0, mismatches, unread, totals }
}

/**
 * The home screen's balance panel, as `balancePanel` returns it ("€12.00\n+ £3.00"), in minor
 * units per currency symbol. en-GB locale is pinned, so the symbol and separators are known.
 */
export function parseBalancePanel(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const m = /([^\d\s+.,-]+)\s?(-?[\d,]+(?:\.\d+)?)/.exec(line.replace(/^\+\s*/, ''))
    if (!m) continue
    const unit = symbolToUnit(m[1]!.trim())
    const digits = m[2]!.replace(/,/g, '')
    const decimals = digits.includes('.') ? digits.split('.')[1]!.length : 0
    out[unit] = (out[unit] ?? 0) + Math.round(Number.parseFloat(digits) * 10 ** decimals)
  }
  return out
}

function symbolToUnit(symbol: string): string {
  return ({ '€': 'EUR', '£': 'GBP', $: 'USD', US$: 'USD', '¥': 'JPY' } as Record<string, string>)[symbol] ?? symbol
}
