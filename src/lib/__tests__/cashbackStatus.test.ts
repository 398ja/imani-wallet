import { describe, it, expect, vi, beforeEach } from 'vitest'

import { fetchCashbackStatus, isTerminalCashbackStatus } from '../cashback'

/**
 * The merchant-side read: did the customer ever type the code in?
 *
 * The rule these tests hold is that a failed check NEVER produces an answer.
 * A merchant deciding whether to honour a code again is the one person a
 * confident guess would actually cost money, so every unhappy path here has to
 * come back null and let the screen say "could not check".
 */

let response: () => Promise<Response>

vi.mock('../wallet', () => ({
  notifyWalletChanged: () => {},
  recordCashbackStatus: async () => {},
}))
vi.mock('../nip98', () => ({
  signedFetch: async () => response(),
}))

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

beforeEach(() => {
  response = async () => json(200, {})
})

describe('isTerminalCashbackStatus', () => {
  it('treats only the four final states as settled', () => {
    expect(isTerminalCashbackStatus('Claimed')).toBe(true)
    expect(isTerminalCashbackStatus('Expired')).toBe(true)
    expect(isTerminalCashbackStatus('Revoked')).toBe(true)
    expect(isTerminalCashbackStatus('ManualAttention')).toBe(true)
    // Still out there, so still worth re-asking.
    expect(isTerminalCashbackStatus('Unclaimed')).toBe(false)
    // Never checked. Absence must not read as settled, or the status would
    // never be fetched at all.
    expect(isTerminalCashbackStatus(undefined)).toBe(false)
  })
})

describe('fetchCashbackStatus', () => {
  it('reports a redemption with the date the customer claimed it', async () => {
    response = async () =>
      json(200, {
        cashbackId: 'cb-1',
        status: 'Claimed',
        claimedAt: '2026-09-01T10:30:00Z',
      })

    expect(await fetchCashbackStatus('cb-1')).toEqual({
      status: 'Claimed',
      claimedAt: Date.parse('2026-09-01T10:30:00Z'),
    })
  })

  it('reports an unclaimed code with no date', async () => {
    response = async () => json(200, { cashbackId: 'cb-1', status: 'Unclaimed' })

    expect(await fetchCashbackStatus('cb-1')).toEqual({
      status: 'Unclaimed',
      claimedAt: undefined,
    })
  })

  it('returns null when the gateway refuses, rather than guessing', async () => {
    response = async () => json(404, { code: 'NOT_FOUND' })
    expect(await fetchCashbackStatus('cb-1')).toBeNull()
  })

  it('returns null when the body carries no status', async () => {
    response = async () => json(200, { cashbackId: 'cb-1' })
    expect(await fetchCashbackStatus('cb-1')).toBeNull()
  })

  it('returns null when the body is not JSON at all', async () => {
    response = async () => new Response('<html>502</html>', { status: 200 })
    expect(await fetchCashbackStatus('cb-1')).toBeNull()
  })

  it('returns null when offline, rather than throwing at the screen', async () => {
    response = async () => {
      throw new TypeError('Failed to fetch')
    }
    expect(await fetchCashbackStatus('cb-1')).toBeNull()
  })

  it('keeps a claimed status when the date is unparseable', async () => {
    // The redemption is the fact that matters; a bad timestamp must not
    // downgrade it to "could not check".
    response = async () => json(200, { status: 'Claimed', claimedAt: 'not-a-date' })

    expect(await fetchCashbackStatus('cb-1')).toEqual({
      status: 'Claimed',
      claimedAt: undefined,
    })
  })
})
