/**
 * The issuer reaches gateway-customer on one address and signs NIP-98 for another (local deploy):
 * the request goes to `walletUrl` (http://gateway-customer:8082, inside the compose network), the
 * `u` tag names the gateway's public base (its GATEWAY_SECURITY_NIP98_PUBLIC_BASE_URL), or the
 * gateway refuses the signature as a URL mismatch.
 */
import { generateSecretKey, nip19 } from 'nostr-tools'
import { describe, expect, it } from 'vitest'

import { LicenceIssuer, sellerFrom } from '../issuer.ts'

const SELLER = sellerFrom(nip19.nsecEncode(generateSecretKey()))

function uTagOf(authorization: string): string {
  const event = JSON.parse(Buffer.from(authorization.replace(/^Nostr /, ''), 'base64').toString()) as { tags: string[][] }
  return event.tags.find((t) => t[0] === 'u')![1]
}

function capture() {
  const seen: Array<{ url: string; u: string }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization
    seen.push({ url: String(url), u: uTagOf(auth) })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return { seen, fetchImpl }
}

describe('NIP-98 audience of the issuer', () => {
  it('signs for the request URL itself by default', async () => {
    const { seen, fetchImpl } = capture()
    await new LicenceIssuer({ walletUrl: 'https://wallet.example.test', edgeSecret: 'e', internalRelay: 'ws://r', seller: SELLER, fetch: fetchImpl }).revoke('sub_1', '')
    expect(seen).toEqual([{ url: 'https://wallet.example.test/api/v1/wallet/licences/revoke', u: 'https://wallet.example.test/api/v1/wallet/licences/revoke' }])
  })

  it('calls the internal address but names the public base when one is set', async () => {
    const { seen, fetchImpl } = capture()
    const issuer = new LicenceIssuer({
      walletUrl: 'http://gateway-customer:8082',
      nip98BaseUrl: 'http://localhost:5173/',
      edgeSecret: 'e',
      internalRelay: 'ws://r',
      seller: SELLER,
      fetch: fetchImpl,
    })
    await issuer.revoke('sub_1', '')
    await issuer.deliver('a'.repeat(64), { token: 't' }, 0)
    expect(seen).toEqual([
      { url: 'http://gateway-customer:8082/api/v1/wallet/licences/revoke', u: 'http://localhost:5173/api/v1/wallet/licences/revoke' },
      { url: 'http://gateway-customer:8082/api/v1/dm/tokens/send', u: 'http://localhost:5173/api/v1/dm/tokens/send' },
    ])
  })
})
