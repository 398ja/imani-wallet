/**
 * @vitest-environment node
 *
 * purchase-issuer's credential confirm, held against the gateway's NIP-98 rules.
 *
 * The wallet's confirm and cancel calls were refused on staging because they carried no
 * `payload` tag (imani-wallet 0.14.1). This service confirms its stall credentials on the same
 * endpoint with its own signer, so it gets the same check: the Authorization it sends must
 * carry a payload tag that is the hash of the body it sends, under the port of
 * imani-security's filter.
 *
 * Before 0.14.2 this service sent no body but signed sha256('') as the payload, which the
 * filter accepts (checked against gateway-customer 0.21.0), so card purchases were not broken.
 * It now sends the same `{}` JSON body as the wallet, and this test pins that shape.
 */
import { describe, expect, it } from 'vitest'

import { confirmCredential } from '../adapters'
import { nip98Refusal, type WireRequest } from '../../../src/lib/__tests__/nip98ServerCheck'
import { delegatedCredential } from './stallFixture'

describe('confirmCredential', () => {
  // What the gateway receives must pass its NIP-98 filter, payload tag included.
  it('signs a payload tag that matches the body it sends', async () => {
    const sent: WireRequest[] = []
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      sent.push({
        url,
        method: init.method ?? 'GET',
        authorization: headers.get('Authorization'),
        contentType: headers.get('Content-Type'),
        body: typeof init.body === 'string' ? init.body : '',
      })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    const ok = await confirmCredential('http://gateway:8082/', delegatedCredential(), fetchImpl)

    expect(ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(
      'http://gateway:8082/api/v1/wallet/terminal-credentials/cred-1/confirm',
    )
    expect(nip98Refusal(sent[0])).toBeNull()
    // The same request shape as the wallet's confirm: a real JSON body, declared as such.
    expect(sent[0].body).toBe('{}')
    expect(sent[0].contentType).toBe('application/json')
  })
})
