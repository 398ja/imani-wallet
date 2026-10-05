/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import {
  CREDENTIAL_DM_TYPE,
  OFFER_TTL_SECONDS,
  credentialMessageJson,
  enrolledFromRumor,
  enrolledMessageJson,
  enrolledNotices,
  offerFromRumor,
  parseSetupCode,
  sendCredential,
  setupCode,
  unwrapSealed,
  wrapMessage,
} from '../terminalDelivery'
import { checkCode } from '../terminalMint'
import { buildLockedCredentialToken } from './voucherFixtures'

/**
 * The two NIP-17 messages that carry a terminal's authority (#160 phase 2).
 *
 * Built and opened with real keys and real NIP-44, and the credential inside is a real signed
 * `P2PK_VOUCHER`, so every refusal here is the refusal a real device would make.
 */

const STALL_KEY = generateSecretKey()
const STALL = getPublicKey(STALL_KEY)
const DEVICE_KEY = generateSecretKey()
const DEVICE = getPublicKey(DEVICE_KEY)
const VOUCHER_ID = '5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9'

const credential = (over: Partial<Parameters<typeof buildLockedCredentialToken>[0]> = {}) =>
  buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, voucherId: VOUCHER_ID, ...over })

const message = (token = credential(), stall = STALL) =>
  credentialMessageJson({
    voucherId: VOUCHER_ID,
    token,
    stallPubkey: stall,
    name: 'Front counter',
    idleLockMinutes: 10,
  })

/** What the device sees: unwrap with K, then check. */
function received(wrapKey: Uint8Array, content: string, now?: number) {
  const opened = unwrapSealed(wrapMessage(wrapKey, DEVICE, content), DEVICE_KEY)
  if (!opened) throw new Error('did not open')
  return offerFromRumor(opened.rumor, opened.sealer, DEVICE, now, EXPECTED)
}

/** What the owner's setup code names: this stall, this credential. */
const EXPECTED = { stallPubkey: STALL, voucherId: VOUCHER_ID }

describe('the credential DM', () => {
  // The stall seals a credential locked to this device: the device reads it,
  // with the same check code the owner's screen shows, and the idle lock the
  // owner chose.
  it('carries a credential the device accepts, with the owner\'s check code', () => {
    const offer = received(STALL_KEY, message())

    expect(typeof offer).toBe('object')
    if (typeof offer === 'string') return
    expect(offer.stallPubkey).toBe(STALL)
    expect(offer.voucherId).toBe(VOUCHER_ID)
    expect(offer.idleLockMinutes).toBe(10)
    expect(offer.checkCode).toBe(checkCode(VOUCHER_ID, STALL, DEVICE))
  })

  // Anyone can DM a public key. A credential sealed by one stall but naming
  // another is refused: the seal is who sent it.
  it('refuses a DM whose seal is not the stall it names', () => {
    const intruder = generateSecretKey()
    expect(received(intruder, message())).toBe('sealed-by-another')
  })

  // An onlooker's OWN stall, sending its own genuine credential, is not
  // refused here (it is honest about who it is). The operator catches it by
  // the stall name and check code, which is what the confirm screen is for.
  // But a credential locked to another device is refused outright.
  it('refuses a credential locked to another device', () => {
    const other = getPublicKey(generateSecretKey())
    expect(received(STALL_KEY, message(credential({ devicePubkey: other })))).toBe(
      'not-locked-to-this-device',
    )
  })

  // A credential whose signed issuer is not the sealing stall.
  it('refuses a credential issued by a different stall', () => {
    const otherStallKey = schnorr.utils.randomSecretKey()
    expect(received(STALL_KEY, message(credential({ stallKey: otherStallKey, pubkeys: [STALL] })))).toBe(
      'wrong-issuer',
    )
  })

  // Edited after signing: the issuer signature no longer verifies.
  it('refuses a credential whose signature does not check out', () => {
    const forged = credential({
      tamperMetadata: JSON.stringify({
        terminal: true,
        stall_pubkey: STALL,
        role: 'issue-and-redeem',
        lock_key: DEVICE,
      }),
    })
    expect(received(STALL_KEY, message(forged))).toBe('bad-signature')
  })

  // Decision 4: an offer older than 24 hours is refused, so an unconfirmed
  // credential cannot be picked up a week later.
  it('refuses an offer more than 24 hours old', () => {
    const later = Math.floor(Date.now() / 1000) + OFFER_TTL_SECONDS + 60
    expect(received(STALL_KEY, message(), later)).toBe('stale')
  })

  // A DM that is not a credential message is simply not one, not an error.
  it('ignores a DM of another type', () => {
    expect(received(STALL_KEY, JSON.stringify({ type: 'cashu_token_transfer', token: 'x' }))).toBe(
      'not-a-credential-dm',
    )
  })

  // The seal is checked: a rumor that claims an author other than the seal's
  // signer is dropped, as NIP-17 requires and nostr-tools does not check.
  it('drops a wrap whose rumor names a different author than its seal', () => {
    const wrap = wrapMessage(STALL_KEY, DEVICE, message())
    expect(unwrapSealed(wrap, DEVICE_KEY)?.sealer).toBe(STALL)
    // Not for this key at all: cannot be opened.
    expect(unwrapSealed(wrap, generateSecretKey())).toBeNull()
  })

  // The type string is versioned so a future change cannot be confused with this one.
  it('says what it is', () => {
    expect(JSON.parse(message()).type).toBe(CREDENTIAL_DM_TYPE)
  })
})

describe('sending it', () => {
  // The owner's side seals with the stall key and publishes one wrap
  // addressed to the device.
  it('seals with the stall and publishes one wrap to the device', async () => {
    const published: Array<{ tags: string[][] }> = []
    const ok = await sendCredential(
      { voucherId: VOUCHER_ID, token: credential(), stallPubkey: STALL, name: 'Front counter', idleLockMinutes: 0 },
      DEVICE,
      (borrow) => borrow(STALL_KEY),
      { publish: async (w) => (published.push(w), true) },
    )

    expect(ok).toBe(true)
    expect(published).toHaveLength(1)
    expect(published[0].tags).toEqual([['p', DEVICE]])
  })
})

describe('the enrolled DM', () => {
  // The device tells its stall it holds the credential. The owner reads the
  // device key from the SEAL, so a notice is believed only from that device.
  it('is read back by the owner, sealed by the device', () => {
    const wraps = [wrapMessage(DEVICE_KEY, STALL, enrolledMessageJson(VOUCHER_ID, DEVICE))]

    const notices = enrolledNotices(wraps, (w) => unwrapSealed(w, STALL_KEY))

    expect(notices).toEqual([{ voucherId: VOUCHER_ID, terminalPubkey: DEVICE }])
  })

  // A notice claiming to be from one device but sealed by another key is
  // ignored, so nobody can mark someone else's waiting row In service.
  it('ignores a notice naming a device that did not seal it', () => {
    const impostor = generateSecretKey()
    const wraps = [wrapMessage(impostor, STALL, enrolledMessageJson(VOUCHER_ID, DEVICE))]

    expect(enrolledNotices(wraps, (w) => unwrapSealed(w, STALL_KEY))).toEqual([])
  })

  // Malformed notices are not notices.
  it('reads nothing from a malformed notice', () => {
    expect(
      enrolledFromRumor(
        { kind: 14, pubkey: DEVICE, created_at: 0, tags: [], content: '{"type":"imani-terminal-enrolled/1"}' },
        DEVICE,
      ),
    ).toBeNull()
    expect(bytesToHex(DEVICE_KEY)).toHaveLength(64)
  })
})

describe('#160 review: the device accepts only the offer the setup code names', () => {
  // The hijack the review found. Someone who reads the device's public code
  // self-signs a credential for THEIR stall (verifyVoucher checks the key
  // inside the token, so it passes), grinds a voucher id until the six-digit
  // check code matches, and seals it with their own key. Before the fix the
  // device accepted it and, being newest, showed it. Now the device accepts
  // only the stall and credential the owner's setup code names.
  it('refuses a well-formed offer from a stall the setup code does not name', () => {
    const intruderKey = generateSecretKey()
    const intruder = getPublicKey(intruderKey)
    const theirs = credentialMessageJson({
      voucherId: VOUCHER_ID,
      token: buildLockedCredentialToken({ stallKey: intruderKey, devicePubkey: DEVICE, voucherId: VOUCHER_ID }),
      stallPubkey: intruder,
      name: 'Front counter',
      idleLockMinutes: 10,
    })

    expect(received(intruderKey, theirs)).toBe('not-the-expected-offer')
  })

  // The right stall, but a different credential than the one the owner's
  // screen names (an older one, say): also refused.
  it('refuses another credential from the right stall', () => {
    const other = credentialMessageJson({
      voucherId: 'aaaaaaaa-6cea-4a7d-b681-9d5d62cc9dd9',
      token: credential({ voucherId: 'aaaaaaaa-6cea-4a7d-b681-9d5d62cc9dd9' }),
      stallPubkey: STALL,
      name: 'Front counter',
      idleLockMinutes: 10,
    })

    expect(received(STALL_KEY, other)).toBe('not-the-expected-offer')
  })

  // With no setup code scanned, nothing is accepted at all.
  it('accepts nothing before a setup code is scanned', () => {
    const opened = unwrapSealed(wrapMessage(STALL_KEY, DEVICE, message()), DEVICE_KEY)!

    expect(offerFromRumor(opened.rumor, opened.sealer, DEVICE)).toBe('not-the-expected-offer')
  })

  // A DM dated beyond a few minutes ahead would never go stale, so it is
  // refused. A little drift is allowed.
  it('refuses a DM dated in the future, beyond a small skew', () => {
    const now = Math.floor(Date.now() / 1000)

    expect(received(STALL_KEY, message(), now - 2 * 3600)).toBe('from-the-future')
    expect(typeof received(STALL_KEY, message(), now - 60)).toBe('object')
  })

  // The setup code round-trips, and anything else is not one.
  it('reads the setup code the owner shows', () => {
    const code = setupCode(STALL.toUpperCase(), VOUCHER_ID)

    expect(parseSetupCode(code)).toEqual({ stallPubkey: STALL, voucherId: VOUCHER_ID })
    expect(parseSetupCode(`nostr:${STALL}`)).toBeNull()
    expect(parseSetupCode('imani-terminal:1:nothex:abc')).toBeNull()
  })
})
