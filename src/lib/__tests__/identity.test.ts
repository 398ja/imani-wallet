import { afterEach, describe, expect, it, vi } from 'vitest'
import { nip19 } from 'nostr-tools'

import { identityLabel, identitySubLabel, resolveNip05 } from '../identity'
import { toRecipientPubkey } from '../issue'

const HEX = 'a'.repeat(64)

describe('identityLabel', () => {
  it('prefers the display name, then the handle, then a short key', () => {
    expect(identityLabel(HEX, { name: 'Rosa Green Farm', nip05: 'rosa@x.test' })).toBe(
      'Rosa Green Farm',
    )
    expect(identityLabel(HEX, { nip05: 'rosa@x.test' })).toBe('rosa@x.test')
    expect(identityLabel(HEX, undefined)).toBe('aaaaaaaa…aaaa')
  })

  it('does not treat a pubkey standing in for a name as a name', () => {
    // `toFarmers` fills `name` with `merchantName || merchantId`, so an
    // unbranded farmer's "name" is 64 hex characters. Passing it through would
    // put back exactly the string this module exists to remove.
    expect(identityLabel(HEX, { name: HEX, nip05: 'rosa@x.test' })).toBe('rosa@x.test')
    expect(identityLabel(HEX, { name: HEX })).toBe('aaaaaaaa…aaaa')
  })

  it('shows the handle under the name, and never under itself', () => {
    expect(identitySubLabel({ name: 'Rosa', nip05: 'rosa@x.test' })).toBe('rosa@x.test')
    expect(identitySubLabel({ nip05: 'rosa@x.test' })).toBeUndefined()
    expect(identitySubLabel({ name: 'Rosa' })).toBeUndefined()
  })
})

describe('resolveNip05', () => {
  afterEach(() => vi.unstubAllGlobals())

  const respond = (status: number, body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: status < 400, json: async () => body }),
    )

  it('returns the hex pubkey the endpoint resolved', async () => {
    respond(200, { nip05: 'rosa@x.test', npub: 'npub1…', hex_pubkey: HEX.toUpperCase() })
    expect(await resolveNip05('rosa@x.test')).toBe(HEX)
  })

  it('returns null for an unknown handle', async () => {
    respond(404, { error: { code: 'NIP05_001' } })
    expect(await resolveNip05('nobody@x.test')).toBeNull()
  })

  it('refuses a resolution that is not a pubkey', async () => {
    // This string becomes the address a coupon is sent to, and it comes from a
    // document the handle's own domain serves.
    respond(200, { hex_pubkey: 'not-a-key' })
    expect(await resolveNip05('rosa@x.test')).toBeNull()
  })
})

describe('toRecipientPubkey', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('takes hex and npub without asking the network', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    expect(await toRecipientPubkey(HEX)).toBe(HEX)
    expect(await toRecipientPubkey(nip19.npubEncode(HEX))).toBe(HEX)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolves a handle, and tolerates a nostr: prefix on one', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hex_pubkey: HEX }) })
    vi.stubGlobal('fetch', fetchSpy)

    expect(await toRecipientPubkey('  rosa@x.test ')).toBe(HEX)
    expect(await toRecipientPubkey('nostr:rosa@x.test')).toBe(HEX)
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/v1/resolve/rosa%40x.test')
  })

  it('does not call the resolver for something that is not an address', async () => {
    // The camera loop feeds this every frame it decodes, most of which are not
    // customer codes at all.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    expect(await toRecipientPubkey('https://example.test/menu')).toBeNull()
    expect(await toRecipientPubkey('')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
