import { describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

/**
 * #402 contract §5: a shop settles each part to the STALL as `P2PK_VOUCHER(data = 02‖stall,
 * n_sigs = 1)`, no locktime, no refund, no sigflag. The stall's receive path must sign the NUT-11
 * witness for that with its own key, and must not sign a part settled to the customer's `R`.
 */
const STALL_KEY = '00000000000000000000000000000000000000000000000000000000000000a1'
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_KEY)))
const CUSTOMER = bytesToHex(schnorr.getPublicKey(hexToBytes('00000000000000000000000000000000000000000000000000000000000000b2')))

vi.mock('../nap', () => ({
  getSigner: () => ({ pubkey: STALL, withPrivkey: <T,>(b: (k: Uint8Array) => T) => b(hexToBytes(STALL_KEY)) }),
}))
const { buildWitnesses } = await import('../witness')

const settled = (to: string, nonce: string, voucherId: string) =>
  JSON.stringify([
    'P2PK_VOUCHER',
    {
      nonce,
      data: `02${to}`,
      tags: [['n_sigs', '1'], ['voucher_id', voucherId], ['issuer', STALL], ['max_sats', '128']],
    },
  ])

describe('a part settled to the stall (#402 §5)', () => {
  it('is signed with the stall key, one witness per proof, the mint accepting each', () => {
    const secrets = [settled(STALL, 'n1', 'v-a'), settled(STALL, 'n2', 'v-a'), settled(STALL, 'n3', 'v-b')]
    const w = buildWitnesses(secrets)
    expect(Object.keys(w)).toHaveLength(3)
    for (const s of secrets) {
      expect(schnorr.verify(hexToBytes(w[s][0]), sha256(utf8ToBytes(s)), hexToBytes(STALL))).toBe(true)
    }
  })

  it('is not signed when it was settled to the customer instead', () => {
    expect(buildWitnesses([settled(CUSTOMER, 'n4', 'v-c')])).toEqual({})
  })
})
