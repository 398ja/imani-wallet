import { describe, it, expect } from 'vitest'

import {
  parseDrainRequest,
  drainBody,
  drainUrl,
  parseAckRequest,
  ackBody,
  parseClaimHandleRequest,
  claimHandleBody,
  claimHandleUrl,
} from '../inbox.js'

/**
 * Collecting arrivals, and claiming a handle.
 *
 * Both are couriers, so most of what could go wrong is in the parsing: a caller
 * acknowledging nothing and draining forever, or claiming a name for a key that
 * did not ask for it.
 */

const CALLER = 'c'.repeat(64)
const OTHER = 'b'.repeat(64)
const RELAYS = ['ws://relay:7777']

describe('draining the inbox', () => {
  it('defaults to fifty, as the app does', () => {
    const r = parseDrainRequest({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.limit).toBe(50)
  })

  it('REFUSES a limit above the ceiling rather than quietly reducing it', () => {
    // A caller asking for a thousand and silently receiving fifty would
    // conclude it had drained the inbox.
    const r = parseDrainRequest({ limit: 1000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('limit')
  })

  it('refuses a limit of zero or less', () => {
    expect(parseDrainRequest({ limit: 0 }).ok).toBe(false)
    expect(parseDrainRequest({ limit: -1 }).ok).toBe(false)
  })

  it('points at gateway-core, where the endpoint answers', () => {
    // A signed POST to the same path returns 404 on customer-wallet. Getting
    // this host wrong is what made the coverage assessment record it as
    // unlocated.
    expect(drainUrl()).toMatch(/\/api\/v1\/incoming-notifications\/drain$/)
  })

  it('serialises the body once, so a signature over it holds', () => {
    expect(drainBody(10)).toBe('{"limit":10}')
  })
})

describe('acknowledging', () => {
  it('REFUSES an empty list', () => {
    // Almost certainly a caller bug: a loop that built nothing and would now
    // drain the same envelopes forever while believing it had acknowledged
    // them.
    const r = parseAckRequest({ ids: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('ids')
  })

  it('names the offending entry, not just the array', () => {
    const r = parseAckRequest({ ids: ['ok', ''] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('ids[1]')
  })

  it('accepts a list of ids', () => {
    expect(parseAckRequest({ ids: ['a', 'b'] }).ok).toBe(true)
    expect(ackBody(['a', 'b'])).toBe('{"ids":["a","b"]}')
  })
})

describe('claiming a handle', () => {
  const parse = (over: Record<string, unknown> = {}) =>
    parseClaimHandleRequest({ username: 'front-counter', ...over }, CALLER, RELAYS)

  it('accepts an ordinary handle', () => {
    const r = parse()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.pubkey).toBe(CALLER)
  })

  it('lowercases it, since a NIP-05 address is not case-sensitive', () => {
    const r = parse({ username: 'Front-Counter' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.username).toBe('front-counter')
  })

  it('REFUSES claiming a handle for another key', () => {
    // The one thing this endpoint must not be usable for: pointing a name at a
    // key whose owner did not ask for it.
    const r = parse({ pubkey: OTHER })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.field).toBe('pubkey')
      expect(r.error.detail).toMatch(/on their behalf/)
    }
  })

  it('allows a caller to name itself', () => {
    expect(parse({ pubkey: CALLER }).ok).toBe(true)
  })

  for (const bad of ['ab', 'has space', 'UPPER@thing', 'x'.repeat(33), '-leading']) {
    it(`refuses \`${bad}\` before the gateway has to`, () => {
      // Refused here rather than there, where the error is about a domain the
      // caller never mentioned.
      expect(parse({ username: bad }).ok).toBe(false)
    })
  }

  it('falls back to the service\u2019s relays when none are given', () => {
    const r = parse()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.relays).toEqual(RELAYS)
  })

  it('refuses a claim with no relay at all', () => {
    // A stall nobody can reach is a name pointing nowhere.
    const r = parseClaimHandleRequest({ username: 'somebody' }, CALLER, [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('relays')
  })

  it('goes to /api/v1/nip05, not the endpoint that wants Basic auth', () => {
    // `/api/v1/register` is bottin's and answers `WWW-Authenticate: Basic`,
    // which a service holding no credentials could never satisfy.
    expect(claimHandleUrl()).toMatch(/\/api\/v1\/nip05$/)
    expect(claimHandleUrl()).not.toMatch(/register/)
  })

  it('sends the handle, the key and the relays, and nothing else', () => {
    const r = parse()
    if (!r.ok) throw new Error('setup failed')
    expect(JSON.parse(claimHandleBody(r.value))).toEqual({
      username: 'front-counter',
      pubkey: CALLER,
      relays: RELAYS,
    })
  })
})
