import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, nip17 } from 'nostr-tools'

import {
  eventBytes,
  fitsOneWrap,
  OversizeEventError,
  RUMOR_KNEE_BYTES,
  RUMOR_FIXED_BYTES,
  WRAP_BUDGET_BYTES,
  WRAP_CONTENT_MAX_BYTES,
  wrapEventBytes,
} from '../wrapSize'

/**
 * #532: the shared size model against the REAL nostr-tools NIP-17 wrap, byte for byte, the way
 * gateway-customer's TokenDmGiftWrapSizeTest checks GiftWrapSizeModel.
 */
const real = (content: string) => {
  const sk = generateSecretKey()
  return eventBytes(nip17.wrapEvent(sk, { publicKey: getPublicKey(generateSecretKey()) }, content))
}

describe('wrapSize model (#532)', () => {
  it.each([1, 31, 32, 33, 200, 1_000, 4_096, 12_345, 20_000, 24_000, WRAP_CONTENT_MAX_BYTES, WRAP_CONTENT_MAX_BYTES + 1, 30_000, 32_000])(
    'predicts a %i-byte content wrap byte for byte',
    (n) => {
      const content = 'a'.repeat(n)
      expect(wrapEventBytes(content)).toBe(real(content))
    },
  )

  it('counts JSON escaping and multi-byte UTF-8 the way the rumor serialises them', () => {
    for (const content of ['{"type":"cashu_token_transfer","token":"cashuB' + 'x'.repeat(9_000) + '"}', 'line\nwith\ttabs\\ and "quotes"'.repeat(300), 'é€😀'.repeat(2_000)]) {
      expect(wrapEventBytes(content)).toBe(real(content))
    }
  })

  it('has the cliff where strfry logged it: 55,121 then 66,045', () => {
    expect(WRAP_CONTENT_MAX_BYTES).toBe(RUMOR_KNEE_BYTES - RUMOR_FIXED_BYTES)
    expect(wrapEventBytes('a'.repeat(WRAP_CONTENT_MAX_BYTES))).toBe(WRAP_BUDGET_BYTES)
    expect(wrapEventBytes('a'.repeat(WRAP_CONTENT_MAX_BYTES + 1))).toBe(66_045)
    expect(fitsOneWrap('a'.repeat(WRAP_CONTENT_MAX_BYTES))).toBe(true)
    expect(fitsOneWrap('a'.repeat(WRAP_CONTENT_MAX_BYTES + 1))).toBe(false)
  })

  it('names the size in its typed error', () => {
    const e = new OversizeEventError(66_045, WRAP_BUDGET_BYTES, 'gift wrap')
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toMatch(/66045 bytes, over the 55121/)
  })
})
