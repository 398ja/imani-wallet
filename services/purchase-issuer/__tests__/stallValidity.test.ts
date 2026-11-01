/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'

import { discharge, VALIDITY_MAX_ATTEMPTS, type Obligation, type Ports } from '../discharge'
import { checkDelegation, couponExpiresAtMs, DELEGATION_SKEW_MARGIN_MS } from '../delegatedWarrant'
import {
  cachedValidityReader,
  NOSTR_QUERY_PATH,
  readStallValidity,
  VALIDITY_CACHE_MS,
  type StallValidity,
} from '../stallValidity'
import { STALL, STALL_SK, delegatedCredential, delegationJson } from './stallFixture'

/**
 * imani-wallet#312: a card coupon lives as long as the STALL says, not a hard-coded year.
 *
 * The stall's term is `voucherValidityDays` on its signed public merchant record (kind 30078,
 * `d=imani:merchant`), read at mint time through the gateway's public event query.
 */

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const FORGER_SK = '9'.repeat(63) + '2'

const OBLIGATION: Obligation = {
  id: 'evt_312',
  paymentRequestId: 'pr-312',
  stallPubkey: STALL,
  faceValue: 2500,
  faceUnit: 'EUR',
  faceDecimals: 2,
  memo: 'card purchase',
  recipient: { kind: 'pubkey', pubkey: 'b'.repeat(64) },
  attempts: 0,
  processorReference: 'pi_312',
}

/** The stall's merchant record, signed by `sk` (the stall unless a test forges it). */
function record(content: Record<string, unknown>, createdAt = 1_700_000_000, sk = STALL_SK) {
  return finalizeEvent(
    { kind: 30078, created_at: createdAt, tags: [['d', 'imani:merchant']], content: JSON.stringify(content) },
    hexToBytes(sk),
  )
}

/** A gateway that answers the event query with `events`, in its own camelCase shape. */
function gatewayWith(events: ReturnType<typeof record>[]) {
  return vi.fn(async (url: string) => {
    expect(url).toBe(`http://gw${NOSTR_QUERY_PATH}`)
    return new Response(
      JSON.stringify({ events: events.map(({ created_at, ...e }) => ({ ...e, createdAt: created_at })) }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
}

const days = (n: number): StallValidity => ({ kind: 'days', days: n, source: 'record' })

/** Mints through a fake gateway and returns the body the mint was sent, plus the outcome. */
async function mintWith(validity: StallValidity, over: Partial<Ports> = {}, obligation = OBLIGATION) {
  const bodies: Record<string, unknown>[] = []
  const filed: { expiresAt?: number }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/wallet/vouchers')) {
        bodies.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ voucher_id: 'v1', token: 'cashuB1', issuer_id: STALL }), { status: 201 })
      }
      return new Response(JSON.stringify({ event_id: 'e1', fulfilment_recorded: true }), { status: 200 })
    }),
  )
  const outcome = await discharge('http://gw', obligation, {
    credentialFor: async () => delegatedCredential(),
    tokenFor: async () => '',
    now: () => NOW,
    sleep: async () => {},
    fileSale: async (_c, sale) => {
      filed.push(sale)
      return true
    },
    validityFor: async () => validity,
    ...over,
  })
  vi.unstubAllGlobals()
  return { outcome, body: bodies[0], filed: filed[0] }
}

describe('the coupon carries the stall\u2019s own term', () => {
  // THE bug: the owner's 90-day stall got one-year coupons by card.
  it('mints a 90-day coupon for a 90-day stall, and files the same expiry', async () => {
    const { outcome, body, filed } = await mintWith(days(90))
    expect(outcome.kind).toBe('discharged')
    expect(body.expires_in_days).toBe(90)
    expect(filed.expiresAt).toBe(Math.floor(NOW / 1000) + 90 * 86_400)
  })

  // The other preset terms go through unchanged.
  it.each([30, 60])('mints an n-day coupon for an n-day stall (%i)', async (n) => {
    const { body, filed } = await mintWith(days(n))
    expect(body.expires_in_days).toBe(n)
    expect(filed.expiresAt).toBe(Math.floor(NOW / 1000) + n * 86_400)
  })

  // Never-expires, reaching the mint (it changed after checkout): nothing minted, parked for a
  // person. A delegated coupon cannot outlive its delegation, so no expiry-less coupon is made.
  it('never mints a never-expiring card coupon, and parks the sale for a person', async () => {
    const { outcome, body } = await mintWith(days(0))
    expect(body).toBeUndefined()
    expect(outcome).toMatchObject({ kind: 'attention' })
    expect((outcome as { reason: string }).reason).toMatch(/^validity_never_expires/)
  })

  // A term longer than the delegation (less a week), reaching the mint: same treatment.
  it('parks a sale whose term would outlive the delegation', async () => {
    const short = delegationJson({ expiresAt: Math.floor(NOW / 1000) + 100 * 86_400 })
    const { outcome, body } = await mintWith(days(730), { credentialFor: async () => delegatedCredential({ delegation: short }) })
    expect(body).toBeUndefined()
    expect((outcome as { reason: string }).reason).toMatch(/^validity_outlives_delegation/)
  })
})

describe('when the stall\u2019s term cannot be read', () => {
  // Fail safe, option (a): no year by default. The row stays OWED and the next pass asks again.
  it('mints nothing and leaves the debt owed, not ambiguous', async () => {
    const { outcome, body } = await mintWith({ kind: 'unreadable', reason: 'merchant record query answered 503' })
    expect(body).toBeUndefined()
    expect(outcome).toEqual({ kind: 'owed', reason: expect.stringMatching(/validity unknown/), ambiguous: false })
  })

  // Bounded: after VALIDITY_MAX_ATTEMPTS passes it is parked for a person instead.
  it('parks the debt once the attempts run out', async () => {
    const { outcome } = await mintWith(
      { kind: 'unreadable', reason: 'down' },
      {},
      { ...OBLIGATION, attempts: VALIDITY_MAX_ATTEMPTS - 1 },
    )
    expect(outcome).toMatchObject({ kind: 'attention', reason: expect.stringMatching(/^validity_unreadable/) })
  })

  // Review of #315: gc answers 200 with NO events when its relay query fails and its cache has no
  // copy. At mint time that is a miss, not the stall's never-expires default (which `/ready`
  // refused before payment): the paid sale stays OWED and is asked again, rather than parked.
  it('treats no signed record at mint time as unknown, not as never-expires', async () => {
    const { outcome, body } = await mintWith({ kind: 'days', days: 0, source: 'default' })
    expect(body).toBeUndefined()
    expect(outcome).toEqual({ kind: 'owed', reason: expect.stringMatching(/no signed merchant record/), ambiguous: false })
  })

  // A record the stall really signed with "never expires" is still refused and parked at once.
  it('still parks a signed never-expires record at once', async () => {
    const { outcome } = await mintWith({ kind: 'days', days: 0, source: 'record' })
    expect(outcome).toMatchObject({ kind: 'attention', reason: expect.stringMatching(/^validity_never_expires/) })
  })

  // The bound is time, not a handful of 15-second passes (review of #315).
  it('waits about an hour of passes before parking', () => {
    expect(VALIDITY_MAX_ATTEMPTS * 15_000).toBeGreaterThanOrEqual(60 * 60_000)
  })

  // A gateway error, a network failure and a malformed answer are all "unreadable": never a guess.
  it('reads a failed or malformed query as unreadable', async () => {
    const fail = (async () => new Response('', { status: 502 })) as unknown as typeof fetch
    const down = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const junk = (async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })) as unknown as typeof fetch
    for (const f of [fail, down, junk]) {
      expect((await readStallValidity('http://gw', STALL, f)).kind).toBe('unreadable')
    }
  })
})

describe('reading the stall\u2019s signed record', () => {
  // The record decodes exactly as the wallet's Sell screen decodes it.
  it('reads voucherValidityDays from the stall\u2019s record', async () => {
    const read = await readStallValidity('http://gw', STALL, gatewayWith([record({ voucherValidityDays: 90 })]))
    expect(read).toEqual({ kind: 'days', days: 90, source: 'record' })
  })

  // Parameterised-replaceable: the newest record is the stall's current term.
  it('takes the newest record', async () => {
    const read = await readStallValidity(
      'http://gw',
      STALL,
      gatewayWith([record({ voucherValidityDays: 30 }, 1_700_000_100), record({ voucherValidityDays: 60 }, 1_700_000_000)]),
    )
    expect(read).toMatchObject({ days: 30 })
  })

  // Anyone can publish a kind-30078 naming the stall. A record not signed by the stall is ignored,
  // even when it is the newest, so a stranger cannot set a stall's coupons to never expire.
  it('ignores a forged record not signed by the stall', async () => {
    const forged = { ...record({ voucherValidityDays: 730 }, 1_700_000_500, FORGER_SK), pubkey: STALL }
    const read = await readStallValidity(
      'http://gw',
      STALL,
      gatewayWith([forged, record({ voucherValidityDays: 90 }, 1_700_000_000)]),
    )
    expect(read).toMatchObject({ days: 90 })
  })

  // A different author's genuine record is not the stall's either.
  it('ignores a record by another key', async () => {
    const read = await readStallValidity('http://gw', STALL, gatewayWith([record({ voucherValidityDays: 30 }, 1, FORGER_SK)]))
    expect(read).toEqual({ kind: 'days', days: 0, source: 'default' })
  })

  // Review of #315: the stall's OWN signed kind-30078s include other `d` records (its issuer
  // delegation, roster, settings). gc has ignored `#d` before (gatewayNostr.ts), so a newer one of
  // those must not be read as the merchant record, nor one of another kind with the merchant `d`.
  it.each([
    ['another d tag', { tags: [['d', 'imani:issuer-delegation']] }],
    ['two d tags', { tags: [['d', 'imani:merchant'], ['d', 'other']] }],
    ['another kind', { kind: 30079 }],
  ])('ignores the stall\u2019s own signed event with %s', async (_name, over) => {
    const odd = finalizeEvent(
      {
        kind: 30078,
        created_at: 1_700_000_900,
        tags: [['d', 'imani:merchant']],
        content: JSON.stringify({ voucherValidityDays: 30 }),
        ...over,
      },
      hexToBytes(STALL_SK),
    )
    const read = await readStallValidity('http://gw', STALL, gatewayWith([odd, record({ voucherValidityDays: 90 })]))
    expect(read).toMatchObject({ days: 90 })
  })

  // A stall that never chose a term, or whose term is not one: the wallet's default, never-expires,
  // which is what Sell would issue for the same stall (merchant.ts DEFAULT_VALIDITY_DAYS).
  it.each([
    ['no record', []],
    ['no term on the record', [record({ issuanceCurrency: 'EUR' })]],
    ['an invalid term', [record({ voucherValidityDays: 3000 })]],
    ['a non-numeric term', [record({ voucherValidityDays: false })]],
  ])('reads %s as the default, never-expires', async (_name, events) => {
    const read = await readStallValidity('http://gw', STALL, gatewayWith(events as ReturnType<typeof record>[]))
    expect(read).toMatchObject({ kind: 'days', days: 0 })
  })
})

describe('the cache', () => {
  // A changed setting is used on a sale after the cache expires, and not re-read before it.
  it('re-reads after VALIDITY_CACHE_MS, so a changed term reaches the next sale', async () => {
    let term = 90
    let clock = 0
    const read = vi.fn(async (): Promise<StallValidity> => days(term))
    const cached = cachedValidityReader(read, () => clock)
    expect(await cached(STALL)).toMatchObject({ days: 90 })
    term = 30
    clock = VALIDITY_CACHE_MS - 1
    expect(await cached(STALL)).toMatchObject({ days: 90 })
    clock = VALIDITY_CACHE_MS
    expect(await cached(STALL)).toMatchObject({ days: 30 })
    expect(read).toHaveBeenCalledTimes(2)
  })

  // A failed read is not remembered: the next sale asks again at once.
  it('does not cache an unreadable answer', async () => {
    const read = vi
      .fn<() => Promise<StallValidity>>()
      .mockResolvedValueOnce({ kind: 'unreadable', reason: 'down' })
      .mockResolvedValueOnce(days(60))
    const cached = cachedValidityReader(read, () => 0)
    expect((await cached(STALL)).kind).toBe('unreadable')
    expect(await cached(STALL)).toMatchObject({ days: 60 })
  })

  // Review of #315: the cache is shared by every stall, so one stall's term must never be served
  // for another. Keyed by stall, case-insensitively.
  it('keeps each stall\u2019s term apart', async () => {
    const other = 'c'.repeat(64)
    const read = vi.fn(async (stall: string): Promise<StallValidity> => days(stall === STALL ? 90 : 30))
    const cached = cachedValidityReader(read, () => 0)
    expect(await cached(STALL)).toMatchObject({ days: 90 })
    expect(await cached(other)).toMatchObject({ days: 30 })
    expect(await cached(STALL.toUpperCase())).toMatchObject({ days: 90 })
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('delegation margin edges', () => {
  const credentialUntil = (expiresAtSec: number) =>
    delegatedCredential({ delegation: delegationJson({ expiresAt: expiresAtSec }) })
  const t = Math.floor(NOW / 1000)

  // Exactly term + margin: accepted. One second less: refused as outliving the delegation.
  it('accepts a delegation ending exactly a week after the coupon, and refuses one a second short', () => {
    const exact = t + 90 * 86_400 + DELEGATION_SKEW_MARGIN_MS / 1000
    expect(checkDelegation(credentialUntil(exact), couponExpiresAtMs(NOW, 90)).ok).toBe(true)
    const short = checkDelegation(credentialUntil(exact - 1), couponExpiresAtMs(NOW, 90))
    expect(short).toMatchObject({ ok: false, code: 'outlives_delegation' })
  })

  // The longest term a stall may choose, against the 737-day delegations #302 issued: only just.
  it('backs a 730-day coupon with a 737-day delegation only on its first day', () => {
    const d737 = credentialUntil(t + 737 * 86_400)
    expect(checkDelegation(d737, couponExpiresAtMs(NOW, 730)).ok).toBe(true)
    expect(checkDelegation(d737, couponExpiresAtMs(NOW + DAY, 730)).ok).toBe(false)
  })

  // No finite delegation backs a coupon with no expiry, however long it is.
  it('refuses never-expires against any delegation', () => {
    const forever = credentialUntil(4_000_000_000)
    expect(couponExpiresAtMs(NOW, 0)).toBeNull()
    expect(checkDelegation(forever, null)).toMatchObject({ ok: false, code: 'never_expires' })
  })

  // A delegation that is wrong in itself keeps its own reason and no validity code.
  it('keeps the delegation\u2019s own faults uncoded', () => {
    const verdict = checkDelegation(delegatedCredential({ delegation: delegationJson({ scope: 'coupon:redeem' }) }), NOW)
    expect(verdict.ok).toBe(false)
    expect((verdict as { code?: string }).code).toBeUndefined()
  })
})
