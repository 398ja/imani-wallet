import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'
import { verifyEvent, type Event } from 'nostr-tools'

/**
 * The stall-side voucher ledger v2 publisher (#310): when it publishes, what it publishes, and
 * that nothing it does can break a redemption or leave the stall key in memory.
 */

const STALL_KEY = schnorr.utils.randomSecretKey()
const STALL = bytesToHex(schnorr.getPublicKey(STALL_KEY))
const OTHER_KEY = schnorr.utils.randomSecretKey()

/** Every array handed to a borrow, so a test can prove each was wiped. */
const borrowed: Uint8Array[] = []
vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: STALL,
    withPrivkey: <T,>(borrow: (key: Uint8Array) => T) => {
      const copy = STALL_KEY.slice()
      borrowed.push(copy)
      try {
        return borrow(copy)
      } finally {
        copy.fill(0)
      }
    },
  }),
}))

const published: Event[] = []
let publishOk = 1
let publishThrows = false
vi.mock('../relay', () => ({
  publish: async (event: Event) => {
    if (publishThrows) throw new Error('relay down')
    published.push(event)
    return { ok: publishOk, total: 1, errors: publishOk === 0 ? ['refused'] : [] }
  },
  allEvents: async () => [],
}))

const { publishRedeemed, voucherLedgerV2Enabled } = await import('../attestation')
const { buildVoucherToken } = await import('./voucherFixtures')
const { read, voucherRef } = await import('../voucherLedgerV2')

const ownToken = (overrides = {}, tamper = {}): string => buildVoucherToken(overrides, [8], tamper, STALL_KEY).token

beforeEach(() => {
  vi.stubEnv('VITE_VOUCHER_LEDGER_V2', 'true')
  published.length = 0
  borrowed.length = 0
  publishOk = 1
  publishThrows = false
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('publishRedeemed', () => {
  it('publishes an event that reads back as REDEEMED, signed by the stall, at the voucher locator', async () => {
    const id = await publishRedeemed({ token: ownToken(), signatureValid: true })
    expect(id).not.toBeNull()
    expect(published).toHaveLength(1)
    const event = published[0]
    expect(verifyEvent(event)).toBe(true)
    // The outer author is a per-voucher key, never the stall.
    expect(event.pubkey).not.toBe(STALL)
    expect(event.kind).toBe(30078)
    const ref = voucherRef(STALL, '1d4410af-70f5-4c14-8606-519404684ea7')
    const opened = read(event, ref, [])
    expect(opened.status).toBe('REDEEMED')
    expect(opened.signer).toBe(STALL)
    // Nothing about the voucher is in clear.
    expect(JSON.stringify(event)).not.toContain(STALL)
    expect(JSON.stringify(event)).not.toContain('1d4410af')
  })

  it('wipes every borrowed copy of the stall key', async () => {
    await publishRedeemed({ token: ownToken(), signatureValid: true })
    expect(borrowed.length).toBeGreaterThan(0)
    for (const key of borrowed) expect(key.every((b) => b === 0)).toBe(true)
  })

  it('is on by default (flag unset, blank or any value) and off only for an explicit false', async () => {
    for (const on of ['', '  ', 'true', 'on', '1']) {
      vi.stubEnv('VITE_VOUCHER_LEDGER_V2', on)
      expect(voucherLedgerV2Enabled()).toBe(true)
    }
    for (const off of ['false', 'FALSE', ' false ']) {
      vi.stubEnv('VITE_VOUCHER_LEDGER_V2', off)
      expect(voucherLedgerV2Enabled()).toBe(false)
      expect(await publishRedeemed({ token: ownToken(), signatureValid: true })).toBeNull()
    }
    expect(published).toHaveLength(0)
    expect(borrowed).toHaveLength(0)
  })

  it('publishes with the flag unset (the default)', async () => {
    vi.stubEnv('VITE_VOUCHER_LEDGER_V2', '')
    expect(await publishRedeemed({ token: ownToken(), signatureValid: true })).not.toBeNull()
    expect(published).toHaveLength(1)
  })

  it('does not publish when the envelope says the signature did not verify', async () => {
    expect(await publishRedeemed({ token: ownToken(), signatureValid: false })).toBeNull()
    expect(published).toHaveLength(0)
  })

  it('does not publish a forged voucher even when the caller claims it verified', async () => {
    expect(await publishRedeemed({ token: ownToken({}, { faceValue: 999_999 }), signatureValid: true })).toBeNull()
    expect(published).toHaveLength(0)
  })

  it("does not publish another stall's voucher", async () => {
    const foreign = buildVoucherToken({}, [8], {}, OTHER_KEY).token
    expect(await publishRedeemed({ token: foreign, signatureValid: true })).toBeNull()
    expect(published).toHaveLength(0)
    for (const key of borrowed) expect(key.every((b) => b === 0)).toBe(true)
  })

  it('does not publish a terminal credential, nor metadata it cannot read (fails closed)', async () => {
    for (const merchantMetadata of ['{"terminal":true}', '{"terminal":"TRUE "}', '{"a":1,"a":2}', 'not json']) {
      expect(await publishRedeemed({ token: ownToken({ merchantMetadata }), signatureValid: true })).toBeNull()
    }
    expect(published).toHaveLength(0)
  })

  it('publishes a coupon whose metadata is an ordinary object', async () => {
    expect(await publishRedeemed({ token: ownToken({ merchantMetadata: '{"name":"Bakery"}' }), signatureValid: true })).not.toBeNull()
  })

  it('never throws: relay refusal, relay exception, garbage token', async () => {
    publishOk = 0
    await expect(publishRedeemed({ token: ownToken(), signatureValid: true })).resolves.toBeNull()
    publishThrows = true
    await expect(publishRedeemed({ token: ownToken(), signatureValid: true })).resolves.toBeNull()
    await expect(publishRedeemed({ token: 'cashuBgarbage', signatureValid: true })).resolves.toBeNull()
    await expect(publishRedeemed({ token: '', signatureValid: true })).resolves.toBeNull()
  })
})
