/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nip17, generateSecretKey, getPublicKey } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

/**
 * The delivery hop: a licence arriving as a gift-wrapped DM.
 *
 * `liveLicence.test.ts` proves the real gateway-minted token verifies and
 * grants. What it does NOT prove is that the token survives the journey — and
 * the journey is the whole of the ticket-03 promise, "a licence arriving by DM
 * is recognised and kept, without the customer activating anything".
 *
 * This wraps the REAL licence in a REAL NIP-17 gift wrap and opens it with the
 * app's own `createDmCryptoAdapter`, the same code path the poller uses. The
 * failure it can catch is specific and would be invisible everywhere else: the
 * receive pipeline rejecting a licence, or stripping the metadata that makes it
 * one, on the way into the wallet.
 */

const TOKEN = readFileSync(
  join(__dirname, 'fixtures/live-licence.token'),
  'utf8',
).trim()

/** The customer's key. The wrap is addressed to it and opened with it. */
const customerSk = generateSecretKey()
const customerPk = getPublicKey(customerSk)
const senderSk = generateSecretKey()

// The adapter reads the key from the signer rather than taking it as an
// argument (deliberately — see dmCrypto's note on `clearKey`), so the signer
// is what has to be stubbed, not the crypto. It comes from `./nap`.
vi.mock('../nap', () => ({
  getSigner: () => ({ privkeyHex: () => bytesToHex(customerSk) }),
}))

const { createDmCryptoAdapter } = await import('../dmCrypto')
const { licenceFromToken } = await import('../licences')
const { forgetLicenceParses } = await import('../licences')

/** The envelope the gateway's TokenDmTransferAdapter emits around a token. */
function envelope(token: string) {
  return JSON.stringify({
    type: 'cashu_token_transfer',
    token,
    memo: 'Imani subscription (annual)',
    face_value: 4000,
    face_unit: 'GBP',
    face_decimals: 2,
  })
}

beforeEach(() => {
  forgetLicenceParses()
})

describe('a licence delivered by DM', () => {
  it('survives a real gift wrap, opened by the app’s own adapter', async () => {
    const adapter = createDmCryptoAdapter()

    // A genuine kind-1059, sealed and wrapped by nostr-tools exactly as the
    // sender would. Not a hand-built object.
    const wraps = nip17.wrapEvent(senderSk, { publicKey: customerPk }, envelope(TOKEN))
    const wrap = Array.isArray(wraps) ? wraps[0] : wraps

    const unwrapped = await adapter.unwrapNip17Dm(wrap as never)

    expect(unwrapped).not.toBeNull()
    expect(unwrapped!.content).toContain('cashuB')
  })

  it('is still a recognisable licence after the round trip', async () => {
    const adapter = createDmCryptoAdapter()
    const wraps = nip17.wrapEvent(senderSk, { publicKey: customerPk }, envelope(TOKEN))
    const wrap = Array.isArray(wraps) ? wraps[0] : wraps

    const unwrapped = await adapter.unwrapNip17Dm(wrap as never)
    const payload = JSON.parse(unwrapped!.content) as { token: string }

    // The bytes that came out of the wrap, read as a licence. If delivery
    // mangled anything — encoding, truncation, re-encoding — the metadata or
    // the signature would not survive this.
    const licence = licenceFromToken(payload.token)
    expect(licence).not.toBeNull()
    expect(licence?.features).toEqual(['terminals'])
    expect(licence?.subscriptionId).toMatch(/^sub_[0-9a-f]{16}$/)
    expect(licence?.lockKey).toBeTruthy()
    expect(payload.token).toBe(TOKEN)
  })

  it('is read by the receive pipeline as the SIGNED voucher, not the envelope', async () => {
    const adapter = createDmCryptoAdapter()

    // The envelope lies: it claims a different face value from the one the
    // issuer signed. `parseTokenTransferMessage` must prefer the voucher, which
    // is the property that stops a sender inflating a coupon — and here it also
    // means a licence cannot be re-labelled in transit.
    const lying = JSON.stringify({
      type: 'cashu_token_transfer',
      token: TOKEN,
      face_value: 999999,
      face_unit: 'EUR',
    })

    const metadata = adapter.parseTokenTransferMessage(lying)

    expect(metadata).not.toBeNull()
    expect(metadata!.faceUnit).toBe('GBP')
    expect(metadata!.faceValue).not.toBe(999999)
  })

  it('does not open a wrap addressed to somebody else', async () => {
    const adapter = createDmCryptoAdapter()
    const strangerPk = getPublicKey(generateSecretKey())

    const wraps = nip17.wrapEvent(senderSk, { publicKey: strangerPk }, envelope(TOKEN))
    const wrap = Array.isArray(wraps) ? wraps[0] : wraps

    // Null rather than a throw: one undecryptable wrap must not stall the poll.
    expect(await adapter.unwrapNip17Dm(wrap as never)).toBeNull()
  })
})
