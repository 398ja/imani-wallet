/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { bytesToHex } from '@noble/hashes/utils'
import { generateSecretKey, nip19 } from 'nostr-tools'

import { GENERIC_ERROR, userMessage } from '../userMessage'
import { toPrivkeyHex } from '../nap'
import { LOGOUT_WARNING } from '../logout'
import { Avatar } from '../../components/ui/Avatar'
import { OWN_ACCOUNT, UNKNOWN_PERSON, UNKNOWN_STALL } from '../format'

/**
 * #324: library errors and key-entry messages reach the screen in plain words.
 *
 * The guard test reads the UI's own copy; it cannot see a message a library
 * throws at runtime. These are the runtime half: `userMessage` filters what a
 * page shows from `e.message`, and the key parser's own messages are written
 * for the person who just pasted a key.
 */
afterEach(cleanup)

describe('userMessage', () => {
  it('passes ordinary messages through untouched', () => {
    expect(userMessage(new Error('Wrong passphrase.'))).toBe('Wrong passphrase.')
    expect(userMessage('Not enough balance.')).toBe('Not enough balance.')
  })

  it.each([
    'relay refused the record: blocked',
    'NIP-98 authentication required but Nostr credentials not set',
    'Invalid npub format',
    'Invalid nsec prefix',
    'nostr/query failed: 502',
    'Invalid stall pubkey: a payment request must name its issuer.',
    'Invalid checksum in bech32 string',
  ])('replaces a message that carries protocol jargon: %s', (raw) => {
    expect(userMessage(new Error(raw))).toBe(GENERIC_ERROR)
  })

  it('uses the caller fallback for jargon, and for nothing at all', () => {
    expect(userMessage(new Error('relay timeout'), 'Send failed.')).toBe('Send failed.')
    expect(userMessage(undefined, 'Send failed.')).toBe('Send failed.')
    expect(userMessage(new Error(''))).toBe(GENERIC_ERROR)
  })
})

describe('entering a backup key', () => {
  const sk = generateSecretKey()
  const hex = bytesToHex(sk)

  it('still ACCEPTS an nsec and raw hex; only the wording changed', () => {
    expect(toPrivkeyHex(nip19.nsecEncode(sk))).toBe(hex)
    expect(toPrivkeyHex(`  ${hex.toUpperCase()}  `)).toBe(hex)
  })

  it.each(['nsec1notavalidkey', 'hello', 'npub1abc', '12345'])(
    'says "backup key", never nsec/hex, for a bad paste: %s',
    (bad) => {
      let message = ''
      try {
        toPrivkeyHex(bad)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toMatch(/backup key/)
      expect(message).not.toMatch(/nsec|npub|hex|bech32|checksum/i)
    },
  )
})

describe('the logout warning', () => {
  it('names the backup key plainly, with no protocol terms', () => {
    expect(LOGOUT_WARNING).toMatch(/backup key/)
    expect(LOGOUT_WARNING).not.toMatch(/nsec|npub|relay|nostr/i)
  })
})

describe('the generic avatar for someone we cannot name yet', () => {
  it.each([UNKNOWN_PERSON, OWN_ACCOUNT, UNKNOWN_STALL])('draws a person glyph, not initials, for %s', (name) => {
    const { container } = render(<Avatar name={name} />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.textContent).toBe('')
  })

  it('still draws initials for a real name', () => {
    const { container } = render(<Avatar name="Amina Okafor" />)
    expect(container.textContent).toBe('AO')
  })
})
