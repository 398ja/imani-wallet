/**
 * The stall's own coupon validity, as wallet-api reads it for a headless issue (#359).
 * Same trust rules as purchase-issuer's: signed, by the stall, `d=imani:merchant`, newest wins.
 */
import { describe, expect, it } from 'vitest'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'

import { createValidityReader, validityFromEvents } from '../stallValidity.js'

const STALL_SK = '7'.repeat(63) + '1'
const STALL = getPublicKey(hexToBytes(STALL_SK))
const FORGER_SK = '9'.repeat(63) + '2'

function record(content: Record<string, unknown>, createdAt = 1_700_000_000, sk = STALL_SK, d = 'imani:merchant'): Event {
  return finalizeEvent(
    { kind: 30078, created_at: createdAt, tags: [['d', d]], content: JSON.stringify(content) },
    hexToBytes(sk),
  )
}

describe('the stall\u2019s validity, from its signed record', () => {
  it('reads a 90-day stall as 90 days', () => {
    expect(validityFromEvents([record({ voucherValidityDays: 90 })], STALL)).toEqual({
      kind: 'days',
      days: 90,
      source: 'record',
    })
  })

  it('takes the newest record the stall signed', () => {
    const old = record({ voucherValidityDays: 30 }, 1_700_000_000)
    const now = record({ voucherValidityDays: 90 }, 1_800_000_000)
    expect(validityFromEvents([now, old], STALL)).toMatchObject({ days: 90 })
    expect(validityFromEvents([old, now], STALL)).toMatchObject({ days: 90 })
  })

  it('ignores a record someone else signed claiming to be the stall', () => {
    const forged = { ...record({ voucherValidityDays: 7 }, 1_900_000_000, FORGER_SK), pubkey: STALL }
    expect(validityFromEvents([forged, record({ voucherValidityDays: 90 })], STALL)).toMatchObject({ days: 90 })
  })

  it('ignores another kind-30078 of the stall\u2019s', () => {
    const other = record({ voucherValidityDays: 7 }, 1_900_000_000, STALL_SK, 'imani:settings')
    expect(validityFromEvents([other, record({ voucherValidityDays: 90 })], STALL)).toMatchObject({ days: 90 })
  })

  it('reads no record as the stall\u2019s default, never expires', () => {
    expect(validityFromEvents([], STALL)).toEqual({ kind: 'days', days: 0, source: 'default' })
  })

  it('reads a relay it could not ask as unreadable, never as a default', async () => {
    const read = createValidityReader(async () => {
      throw new Error('relay unreachable')
    })
    expect(await read(STALL)).toEqual({ kind: 'unreadable', reason: 'relay unreachable' })
  })

  it('asks for the stall in lower case', async () => {
    const asked: string[] = []
    const read = createValidityReader(async (pubkey) => {
      asked.push(pubkey)
      return [record({ voucherValidityDays: 60 })]
    })
    expect(await read(STALL.toUpperCase())).toMatchObject({ days: 60 })
    expect(asked).toEqual([STALL])
  })
})
