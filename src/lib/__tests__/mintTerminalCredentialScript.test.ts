/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

// @ts-expect-error a plain .mjs script with no type declarations
import { confirmCredential } from '../../../scripts/mint-terminal-credential.mjs'

/**
 * scripts/mint-terminal-credential.mjs puts what it mints in service (#160 round 2).
 *
 * Since gateway-customer V27 a terminal credential nobody confirmed can never
 * sell, so a credential minted by this script without a confirm would be a
 * fixture that looks right and is refused at the till.
 */
describe('the mint script confirms its credential', () => {
  const sk = schnorr.utils.randomSecretKey()
  const stall = { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }

  // It POSTs /confirm for the voucher it minted, signed as the stall.
  it('confirms as the stall', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))

    await confirmCredential(stall, 'v-1', fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/api\/v1\/wallet\/terminal-credentials\/v-1\/confirm$/)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Auth-Pubkey']).toBe(stall.pk)
  })

  // Anything but 204 fails the run, so nobody commits a credential that cannot sell.
  it('fails loudly when the gateway does not confirm', async () => {
    const fetchImpl = vi.fn(async () => new Response('gone', { status: 410 }))

    await expect(confirmCredential(stall, 'v-1', fetchImpl)).rejects.toThrow(/confirm failed 410/)
  })
})
