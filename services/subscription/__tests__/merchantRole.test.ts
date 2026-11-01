/**
 * @vitest-environment node
 *
 * Who counts as a merchant for the subscription site (#411): the stall's own signed, live
 * `imani:merchant` record, read from the gateway's public nostr query.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { describe, expect, it, vi } from 'vitest'

import { cachedMerchantReader, MERCHANT_D_TAG, MERCHANT_KIND, readMerchantStanding, standingFromEvents } from '../merchantRole.ts'

const SK = generateSecretKey()
const PK = getPublicKey(SK)

const record = (content: object | string, opts: { sk?: Uint8Array; d?: string; kind?: number; at?: number } = {}) =>
  finalizeEvent(
    {
      kind: opts.kind ?? MERCHANT_KIND,
      created_at: opts.at ?? 1_800_000_000,
      tags: [['d', opts.d ?? MERCHANT_D_TAG]],
      content: typeof content === 'string' ? content : JSON.stringify(content),
    },
    opts.sk ?? SK,
  )

describe('standingFromEvents', () => {
  it('a signed live record makes a merchant', () => {
    expect(standingFromEvents([record({ active: true, issuanceCurrency: 'GBP' })], PK)).toBe('merchant')
  })

  it('no record, or a retired one, is a customer', () => {
    expect(standingFromEvents([], PK)).toBe('customer')
    expect(standingFromEvents([record({ active: false })], PK)).toBe('customer')
  })

  it('a record without `active`, or unparseable, still counts (publishing it is the act)', () => {
    expect(standingFromEvents([record({ issuanceCurrency: 'EUR' })], PK)).toBe('merchant')
    expect(standingFromEvents([record('not json')], PK)).toBe('merchant')
  })

  it('the NEWEST record wins: retiring after being active ends it, and re-activating restores it', () => {
    const on = record({ active: true }, { at: 100 })
    const off = record({ active: false }, { at: 200 })
    expect(standingFromEvents([on, off], PK)).toBe('customer')
    expect(standingFromEvents([off, record({ active: true }, { at: 300 })], PK)).toBe('merchant')
  })

  it('only events the stall SIGNED count: a forged author, a bad signature, another d tag or kind do not', () => {
    const other = generateSecretKey()
    const forgedAuthor = { ...record({ active: true }, { sk: other }), pubkey: PK }
    const badSig = { ...record({ active: true }), sig: '0'.repeat(128) }
    expect(standingFromEvents([forgedAuthor], PK)).toBe('customer')
    expect(standingFromEvents([badSig], PK)).toBe('customer')
    expect(standingFromEvents([record({ active: true }, { d: 'imani:merchant:x' })], PK)).toBe('customer')
    expect(standingFromEvents([record({ active: true }, { kind: 0 })], PK)).toBe('customer')
    expect(standingFromEvents([record({ active: true }, { sk: other })], PK)).toBe('customer')
  })
})

describe('readMerchantStanding', () => {
  it('asks the gateway for exactly this author, kind and d tag', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ events: [record({ active: true })] })))
    expect(await readMerchantStanding('http://gw/', PK.toUpperCase(), fetchImpl)).toBe('merchant')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://gw/api/v1/nostr/query')
    expect(JSON.parse(String(init?.body))).toMatchObject({ kinds: [MERCHANT_KIND], authors: [PK], tags: { '#d': [MERCHANT_D_TAG] } })
  })

  it('reads the gateway camelCase `createdAt` too', async () => {
    const e = record({ active: true })
    const { created_at, ...rest } = e
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ events: [{ ...rest, createdAt: created_at }] })))
    expect(await readMerchantStanding('http://gw', PK, fetchImpl)).toBe('merchant')
  })

  it('an answer with no stall record is a customer; an unreachable or odd gateway is unknown', async () => {
    expect(await readMerchantStanding('http://gw', PK, async () => new Response(JSON.stringify({ events: [] })))).toBe('customer')
    expect(await readMerchantStanding('http://gw', PK, async () => new Response('nope', { status: 503 }))).toBe('unknown')
    expect(await readMerchantStanding('http://gw', PK, async () => new Response(JSON.stringify({ nothing: true })))).toBe('unknown')
    expect(
      await readMerchantStanding('http://gw', PK, async () => {
        throw new Error('ECONNREFUSED')
      }),
    ).toBe('unknown')
  })
})

describe('cachedMerchantReader', () => {
  it('caches a merchant answer for the TTL, and never caches a refusal or a failure', async () => {
    let clock = 0
    const answers = ['merchant', 'customer', 'unknown', 'merchant'] as const
    const read = vi.fn(async () => answers[read.mock.calls.length - 1])
    const reader = cachedMerchantReader(read, () => clock, 1000)
    expect(await reader(PK)).toBe('merchant')
    expect(await reader(PK)).toBe('merchant')
    expect(read).toHaveBeenCalledTimes(1)
    clock = 1001
    expect(await reader(PK)).toBe('customer')
    expect(await reader(PK)).toBe('unknown')
    expect(await reader(PK)).toBe('merchant')
    expect(read).toHaveBeenCalledTimes(4)
  })
})
