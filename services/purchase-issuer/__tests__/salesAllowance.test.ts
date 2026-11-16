import { verifyEvent, type Event } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'

import { CREDENTIAL_HEADER, type StallCredential } from '../issuer'
import {
  allowanceVerdict,
  cachedAllowanceReader,
  normaliseUnit,
  readSalesAllowance,
  SALES_ALLOWANCE_PATH,
  type SalesPosition,
} from '../salesAllowance'
import { LOCK, LOCK_PUB, STALL } from './stallFixture'

const CREDENTIAL: StallCredential = { stallPubkey: STALL, credentialId: 'cred-0001', lockKeyHex: LOCK }

function gatewayAnswering(status: number, body: unknown) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url, headers: init.headers as Record<string, string> })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { seen, fetchImpl }
}

describe('reading a stall\u2019s sales allowance (gc#317)', () => {
  // Asked as issuance asks: NIP-98 by the lock key over the exact URL, credential in its header.
  it('signs the request with the lock key and names the credential', async () => {
    const gw = gatewayAnswering(200, { limited: false })
    expect(await readSalesAllowance('http://gw/', CREDENTIAL, 'GBP', gw.fetchImpl)).toEqual({ kind: 'unlimited' })
    const { url, headers } = gw.seen[0]
    expect(url).toBe(`http://gw${SALES_ALLOWANCE_PATH}?unit=GBP`)
    expect(headers[CREDENTIAL_HEADER]).toBe('cred-0001')
    const event = JSON.parse(atob(headers.Authorization.replace(/^Nostr /, ''))) as Event
    expect(event.kind).toBe(27235)
    expect(event.pubkey).toBe(LOCK_PUB)
    expect(event.tags.find((t) => t[0] === 'u')?.[1]).toBe(url)
    expect(event.tags.find((t) => t[0] === 'method')?.[1]).toBe('GET')
    expect(verifyEvent(event)).toBe(true)
  })

  it('reads a free stall\u2019s position', async () => {
    const gw = gatewayAnswering(200, {
      limited: true,
      unit: 'GBP',
      used_minor: 3000,
      allowance_minor: 10000,
      remaining_minor: 7000,
      reached: false,
    })
    expect(await readSalesAllowance('http://gw', CREDENTIAL, 'GBP', gw.fetchImpl)).toEqual({
      kind: 'limited',
      unit: 'GBP',
      remainingMinor: 7000,
    })
  })

  // The gateway's own `reached` wins, whatever `remaining` says.
  it('reads reached as nothing left', async () => {
    const gw = gatewayAnswering(200, { limited: true, unit: 'GBP', remaining_minor: 5, reached: true })
    expect(await readSalesAllowance('http://gw', CREDENTIAL, 'GBP', gw.fetchImpl)).toMatchObject({ remainingMinor: 0 })
  })

  // Anything else is unknown, never a guess either way.
  it.each<[number, unknown]>([
    [403, ''],
    [503, ''],
    [200, 'not json'],
    [200, null],
    [200, { limited: true }],
    [200, { limited: true, remaining_minor: '7000' }],
    [200, { limited: 'yes' }],
  ])('reads %i %o as unknown', async (status, body) => {
    const gw = gatewayAnswering(status, body)
    expect((await readSalesAllowance('http://gw', CREDENTIAL, 'GBP', gw.fetchImpl)).kind).toBe('unknown')
  })

  it('reads an unreachable gateway as unknown', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect((await readSalesAllowance('http://gw', CREDENTIAL, 'GBP', down)).kind).toBe('unknown')
  })
})

describe('the allowance cache', () => {
  // Answers are kept for the TTL, per stall and unit; unknowns are asked again at once.
  it('caches answers briefly and never an unknown', async () => {
    let t = 0
    let answer: SalesPosition = { kind: 'unknown', reason: 'down' }
    let calls = 0
    const read = cachedAllowanceReader(
      async () => {
        calls += 1
        return answer
      },
      () => t,
      10_000,
    )
    await read(CREDENTIAL, 'GBP')
    await read(CREDENTIAL, 'GBP')
    expect(calls).toBe(2)
    answer = { kind: 'limited', unit: 'GBP', remainingMinor: 0 }
    await read(CREDENTIAL, 'GBP')
    await read(CREDENTIAL, 'GBP')
    expect(calls).toBe(3)
    await read(CREDENTIAL, 'EUR')
    expect(calls).toBe(4)
    t = 10_001
    await read(CREDENTIAL, 'GBP')
    expect(calls).toBe(5)
  })

  // A stall that enrols again is asked with its new credential, not served the old one's answer.
  it('keys by credential', async () => {
    let calls = 0
    const read = cachedAllowanceReader(async () => {
      calls += 1
      return { kind: 'unlimited' }
    })
    await read(CREDENTIAL, 'GBP')
    await read({ ...CREDENTIAL, credentialId: 'cred-0002' }, 'GBP')
    expect(calls).toBe(2)
  })
})

describe('what a position means for a sale', () => {
  const left = (n: number): SalesPosition => ({ kind: 'limited', unit: 'GBP', remainingMinor: n })

  it.each<[SalesPosition, number | null, string]>([
    [{ kind: 'unlimited' }, 1_000_000, 'ok'],
    [{ kind: 'unknown', reason: 'x' }, 100, 'unknown'],
    [left(0), null, 'reached'],
    [left(0), 1, 'reached'],
    [left(100), null, 'ok'],
    [left(100), 100, 'ok'],
    [left(100), 101, 'exceeded'],
  ])('%o for %s is %s', (position, amount, verdict) => {
    expect(allowanceVerdict(position, amount)).toBe(verdict)
  })

  it.each([
    ['gbp', 'GBP'],
    [' Eur ', 'EUR'],
    ['pounds', null],
    ['', null],
    [7, null],
    [null, null],
  ])('normalises %o to %o', (raw, unit) => {
    expect(normaliseUnit(raw)).toBe(unit)
  })
})
