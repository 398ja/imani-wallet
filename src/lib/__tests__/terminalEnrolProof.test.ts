import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { nip19 } from 'nostr-tools'

import {
  ENROLMENT_CODE_MESSAGES,
  enrolmentDigest,
  enrolmentProofHeader,
  readEnrolmentCode,
  signEnrolmentCode,
} from '../terminalEnrolProof'

/**
 * inv-terminal-not-merchant (owner decision 2026-10-11): a terminal is a key created AS a terminal.
 * Only the device's own signed setup code is accepted; an account's npub, hex or handle is not.
 */
const NOW = 1_791_000_000
const key = schnorr.utils.randomSecretKey()
const K = bytesToHex(schnorr.getPublicKey(key))

describe('the device enrolment code', () => {
  it('is read back as the key and a proof the gateway can verify', () => {
    const read = readEnrolmentCode(signEnrolmentCode(key, K, NOW), NOW)
    expect(read).toEqual({ terminalPubkey: K, createdAt: NOW, sig: expect.stringMatching(/^[0-9a-f]{128}$/) })
    if (typeof read === 'string') throw new Error(read)
    expect(enrolmentProofHeader(read)).toBe(`1:${NOW}:${read.sig}`)
    // The same bytes gateway-customer verifies (TerminalEnrolmentProof.digest).
    expect(schnorr.verify(hexToBytes(read.sig), enrolmentDigest(K, NOW), hexToBytes(K))).toBe(true)
  })

  it('tolerates a nostr: prefix and upper case', () => {
    expect(typeof readEnrolmentCode(`nostr:${signEnrolmentCode(key, K, NOW).toUpperCase()}`, NOW)).toBe('object')
  })

  // The owner's real failure: a logged-in customer's receive QR scanned as the till.
  it('refuses an account: npub, nostr:npub, hex key and handle', () => {
    for (const text of [nip19.npubEncode(K), `nostr:${nip19.npubEncode(K)}`, K, `nostr:${K}`, 'cocoa@imani.cash']) {
      expect(readEnrolmentCode(text, NOW)).toBe('not-a-terminal-code')
    }
    expect(ENROLMENT_CODE_MESSAGES['not-a-terminal-code']).toBe(
      "That is a personal account, not a terminal. On the device, open Imani and choose 'Set this device up as a terminal'.",
    )
  })

  // Nobody can make a code for a key they do not hold: an owner cannot enrol someone else's account.
  it('refuses a code signed by another key', () => {
    const other = schnorr.utils.randomSecretKey()
    const forged = signEnrolmentCode(other, K, NOW)
    expect(readEnrolmentCode(forged, NOW)).toBe('bad-signature')
  })

  it('refuses a stale or future code', () => {
    expect(readEnrolmentCode(signEnrolmentCode(key, K, NOW - 24 * 3600 - 1), NOW)).toBe('expired')
    expect(readEnrolmentCode(signEnrolmentCode(key, K, NOW + 601), NOW)).toBe('expired')
  })
})
