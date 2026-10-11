import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

vi.mock('../terminalDeliveryNet', () => ({ collectEnrolled: vi.fn(async () => 0) }))
vi.mock('../nap', () => ({
  getSigner: () => {
    throw new Error('not needed: these tests never unwrap')
  },
}))

const { createDmCryptoAdapter } = await import('../dmCrypto')
const { credentialMessageJson } = await import('../terminalDelivery')
const { renewRequestJson } = await import('../terminalRenewal')
const { buildLockedCredentialToken, buildVoucherToken, dmEnvelope } = await import('./voucherFixtures')

/**
 * A terminal credential reaching a PERSONAL wallet is never redeemed as money (#160, owner report).
 *
 * Reproduced: an owner enrolled a logged-in customer's npub as a terminal key. The credential DM
 * (`imani-terminal-credential/1`) is JSON, but not `cashu_token_transfer`, so `extractToken` fell
 * through to dm-poll's text regex, which found the `cashuB…` token inside it. dm-poll swapped it
 * at the mint: 1 sat in the balance, a coupon in the carousel, "Payment received", and the
 * credential spent as money rather than held as authority.
 */

const STALL_KEY = generateSecretKey()
const STALL = getPublicKey(STALL_KEY)
const DEVICE = getPublicKey(generateSecretKey())
const TOKEN = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE })
const crypto = createDmCryptoAdapter()

describe('terminal DMs are not payments', () => {
  it('the credential DM yields no token', () => {
    const dm = credentialMessageJson({ voucherId: 'v1', token: TOKEN, stallPubkey: STALL, name: 'Till', idleLockMinutes: 10 })
    expect(crypto.extractToken(dm)).toBeNull()
  })

  it('a renewal (a credential DM with `renews`) yields no token', () => {
    const dm = JSON.stringify({
      ...JSON.parse(credentialMessageJson({ voucherId: 'v2', token: TOKEN, stallPubkey: STALL, name: 'Till', idleLockMinutes: 10 })),
      renews: 'v1',
    })
    expect(crypto.extractToken(dm)).toBeNull()
  })

  it("a till's renew request, which carries its credential to the stall, yields no token", () => {
    expect(crypto.extractToken(renewRequestJson('v1', TOKEN))).toBeNull()
  })

  it('a credential wrapped as an ordinary token transfer is still not redeemed', () => {
    const dm = JSON.stringify({ type: 'cashu_token_transfer', token: TOKEN, face_value: 1, face_unit: 'sat' })
    expect(crypto.extractToken(dm)).toBeNull()
  })

  it('an ordinary coupon still comes through', () => {
    const { token } = buildVoucherToken()
    expect(crypto.extractToken(dmEnvelope(token))).toBe(token)
  })

  it('a legacy text DM still comes through', () => {
    expect(crypto.extractToken('🎁 Token Transfer: 1.00 USD\ncashuAtoken123')).toContain('cashuA')
  })
})
