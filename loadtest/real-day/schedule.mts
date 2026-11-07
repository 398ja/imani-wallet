/**
 * Who does what, when: the seeded part of a real day (#550). Pure, so it is unit tested and two
 * runs with the same SEED plan the same day.
 */

export const JOURNEYS = [
  'arrive',
  'buy',
  'pay',
  'send',
  'link',
  'online',
  'cashlink',
  'browse',
  'card',
  'leave',
] as const
export type Journey = (typeof JOURNEYS)[number]

/** Relative weights over a day (issue #550: high / medium / low). `arrive` is not drawn: it opens a visit. */
export const WEIGHTS: Record<Exclude<Journey, 'arrive'>, number> = {
  buy: 30,
  pay: 25,
  send: 15,
  browse: 15,
  leave: 6,
  link: 4,
  cashlink: 4,
  online: 3,
  card: 3,
}

/** What a journey needs the customer to hold already; if they do not, the scheduler buys first. */
export const NEEDS_COUPONS: ReadonlySet<Journey> = new Set(['pay', 'send', 'link', 'online'])

/** mulberry32: small, fast, and identical in every runtime, which is all reproducibility needs. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A stable per-persona stream derived from the run seed, so adding a persona does not reshuffle the others. */
export function seedFor(runSeed: number, persona: string): number {
  let h = 2166136261 ^ runSeed
  for (let i = 0; i < persona.length; i++) h = Math.imul(h ^ persona.charCodeAt(i), 16777619)
  return h >>> 0
}

export function pickWeighted<K extends string>(random: () => number, weights: Record<K, number>): K {
  const entries = Object.entries(weights) as [K, number][]
  const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0)
  if (total <= 0) throw new Error('no journey has a positive weight')
  let r = random() * total
  for (const [k, w] of entries) {
    if (w <= 0) continue
    r -= w
    if (r < 0) return k
  }
  return entries.filter(([, w]) => w > 0).at(-1)![0]
}

/** Think time between actions, 5 to 40 s by default (issue #550). */
export function thinkMs(random: () => number, minS = 5, maxS = 40): number {
  return Math.round((minS + random() * (maxS - minS)) * 1000)
}

/**
 * The next journey for a customer. A journey that spends coupons when none are held becomes a
 * buy (a customer with nothing to pay with goes to a stall first). `skip` removes journeys that
 * are known up front not to run, so the day is not spent drawing SKIPs.
 */
export function nextJourney(
  random: () => number,
  state: { holdsCoupons: boolean },
  weights: Partial<Record<Exclude<Journey, 'arrive'>, number>> = WEIGHTS,
): Exclude<Journey, 'arrive'> {
  const w = { ...WEIGHTS, ...weights }
  const drawn = pickWeighted(random, w)
  if (NEEDS_COUPONS.has(drawn) && !state.holdsCoupons) return 'buy'
  return drawn
}

/** An integer amount in minor units, [minMinor, maxMinor], on a 50-minor grid (0.50, 1.00, …). */
export function amountMinor(random: () => number, minMinor = 50, maxMinor = 200): number {
  const steps = Math.floor((maxMinor - minMinor) / 50)
  return minMinor + 50 * Math.floor(random() * (steps + 1))
}

export function formatMinor(minor: number, decimals = 2): string {
  return (minor / 10 ** decimals).toFixed(decimals)
}

/**
 * The smoke plan: every journey once, in an order where each one's preconditions are met by the
 * ones before it, spread across the customers. `arrive` opens each customer's visit.
 */
export function smokePlan(customers: string[]): { persona: string; journey: Journey }[] {
  if (customers.length === 0) return []
  const plan: { persona: string; journey: Journey }[] = customers.map((persona) => ({ persona, journey: 'arrive' }))
  const order: Journey[] = ['buy', 'buy', 'pay', 'send', 'link', 'online', 'cashlink', 'browse', 'card', 'leave']
  order.forEach((journey, i) => {
    // The first customer does the coupon-holding chain (buy, buy, pay, send, link, online) so
    // their holdings are known; the rest share the others round-robin.
    const persona = i < 6 ? customers[0]! : customers[(i - 5) % customers.length]!
    plan.push({ persona, journey })
  })
  return plan
}
