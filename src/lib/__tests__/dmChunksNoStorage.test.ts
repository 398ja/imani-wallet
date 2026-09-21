/**
 * `dmChunks` where there is no `localStorage` at all.
 *
 * Not a hypothetical. This suite's default environment is `node`, a service
 * worker has no `localStorage`, and a browser in a private-browsing mode
 * throws on access rather than returning null. Persisting the completed-
 * transfer set introduced three new points that touch storage -- module load,
 * completion, and sweep -- and any one of them throwing would take down the
 * whole receive path to save a cache.
 *
 * So the rule is: durability is best-effort, reassembly is not.
 */
import { describe, it, expect } from 'vitest'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import { asChunk, offerChunk } from '../dmChunks'

describe('with no localStorage', () => {
  it('still reassembles a chunked coupon', async () => {
    expect(typeof localStorage).toBe('undefined')

    const payload = JSON.stringify({
      type: 'cashu_token_transfer',
      token: 'cashuA'.repeat(400),
    })
    const bytes = new TextEncoder().encode(payload)
    const b64 = Buffer.from(bytes).toString('base64')
    const per = Math.ceil(b64.length / 4)

    let whole: string | null = null
    for (let i = 0; i < 4; i += 1) {
      const chunk = asChunk(
        JSON.stringify({
          type: 'cashu_dm_chunk',
          transfer_id: 'no-storage',
          chunk_index: i,
          chunk_total: 4,
          content_encoding: 'identity',
          content_length: bytes.length,
          content_sha256: bytesToHex(sha256(bytes)),
          payload: b64.slice(i * per, (i + 1) * per),
        }),
      )
      expect(chunk).not.toBeNull()
      whole = await offerChunk(chunk!)
    }

    // The customer's coupon arrives. Only the durability is lost.
    expect(whole).toBe(payload)
  })
})
