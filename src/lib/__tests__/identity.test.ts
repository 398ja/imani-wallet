import { afterEach, describe, expect, it, vi } from 'vitest'
import { nip19 } from 'nostr-tools'

import {
  humanName,
  identityLabel,
  identitySubLabel,
  nameOrNothing,
  resolveNip05,
} from '../identity'
import { toRecipientPubkey } from '../issue'
import { clearConfigCache } from '../config'

const HEX = 'a'.repeat(64)

describe('humanName', () => {
  /**
   * The settlement receipt on the transaction detail screen printed 64 hex
   * characters beside the amount: `_buildReceiveTransactionRow` fills
   * `merchantName` from the coupon's merchant metadata, and for a stall that has
   * published no kind-0 profile that value IS the merchant_id. Every other name
   * on that screen goes through IdentityInline, which never renders a full key.
   */
  it('refuses a key wearing a name\'s clothes', () => {
    expect(humanName(HEX)).toBeUndefined()
    expect(humanName(HEX.toUpperCase())).toBeUndefined()
    expect(humanName(` ${HEX} `)).toBeUndefined()
  })

  it('passes a real name through untouched', () => {
    expect(humanName('Rosa Green Farm')).toBe('Rosa Green Farm')
    // A name that merely contains hex is still a name.
    expect(humanName('Cafe abc123')).toBe('Cafe abc123')
    // 63 and 65 chars are not pubkeys.
    expect(humanName('a'.repeat(63))).toBe('a'.repeat(63))
  })

  it('has nothing to say about nothing', () => {
    expect(humanName(undefined)).toBeUndefined()
  })
})

describe('identityLabel', () => {
  it('prefers the display name, then the handle, then a short key', () => {
    expect(identityLabel(HEX, { name: 'Rosa Green Farm', nip05: 'rosa@x.test' })).toBe(
      'Rosa Green Farm',
    )
    expect(identityLabel(HEX, { nip05: 'rosa@x.test' })).toBe('@rosa')
    expect(identityLabel(HEX, undefined)).toBe('aaaaaaaa…aaaa')
  })

  it('does not treat a pubkey standing in for a name as a name', () => {
    // `toMerchants` fills `name` with `merchantName || merchantId`, so an
    // unbranded merchant's "name" is 64 hex characters. Passing it through would
    // put back exactly the string this module exists to remove.
    expect(identityLabel(HEX, { name: HEX, nip05: 'rosa@x.test' })).toBe('@rosa')
    expect(identityLabel(HEX, { name: HEX })).toBe('aaaaaaaa…aaaa')
  })

  it('shows the handle under the name, and never under itself', () => {
    expect(identitySubLabel({ name: 'Rosa', nip05: 'rosa@x.test' })).toBe('@rosa')
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
  afterEach(() => {
    vi.unstubAllGlobals()
    // The gateway config is cached for the session; a domain stubbed in one
    // case must not answer the next one's fetch that never happened.
    clearConfigCache()
  })

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

  it('completes a bare localpart with the gateway own domain', async () => {
    // Nearly every customer a merchant serves is registered on the merchant's
    // own gateway, so typing that domain is keystrokes for nothing.
    const fetchSpy = vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          url === '/api/v1/config' ? { nip05_domain: 'x.test' } : { hex_pubkey: HEX },
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    expect(await toRecipientPubkey('rosa')).toBe(HEX)
    // `@rosa` is how the app prints a handle, so it is how one gets typed back.
    expect(await toRecipientPubkey('@rosa')).toBe(HEX)
    expect(fetchSpy.mock.calls.at(-1)?.[0]).toBe('/api/v1/resolve/rosa%40x.test')
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

/**
 * The settlement toast showed `b233db85…de1e` where a sender's name belongs.
 *
 * `identityLabel` ends its ladder at `shortPubkey`, which is right for a list
 * row — a stable identifier beats an empty cell there — and wrong for a toast,
 * where a hex fragment beside an amount names nobody. The sending wallet on
 * staging had published no kind-0, so every rung missed and the key fell out
 * of the bottom. The pending toast never showed this because its envelope
 * carries a `displayName` to fall back on; the DM payload behind the
 * settlement toast carries no such field.
 */
describe('nameOrNothing', () => {
  it('is nothing when the profile never resolved, rather than a shortened key', () => {
    expect(nameOrNothing(HEX, undefined)).toBeUndefined()
    // The exact staging shape: a fetch that came back with no name and no handle.
    expect(nameOrNothing(HEX, {})).toBeUndefined()
    // And it must not be the key by any route.
    expect(identityLabel(HEX, undefined)).toContain('…')
  })

  it('is nothing when there is no counterparty at all', () => {
    // "no sender" and "a sender we cannot name" read the same to a person, so
    // they collapse to one case and one set of words.
    expect(nameOrNothing(undefined, undefined)).toBeUndefined()
    expect(nameOrNothing('', { name: 'ignored' })).toBeUndefined()
  })

  it('is the display name when the profile has one', () => {
    expect(nameOrNothing(HEX, { name: 'Rosa Green Farm' })).toBe('Rosa Green Farm')
  })

  it('falls back to the handle when there is no display name', () => {
    expect(nameOrNothing(HEX, { nip05: 'rosa@x.test' })).toBe('@rosa')
  })

  /**
   * `toMerchants` fills `name` with `merchantName || merchantId`, so an
   * unbranded merchant's "name" is a 64-character pubkey. That must not
   * sneak past as a name.
   */
  it('rejects a pubkey wearing a name field', () => {
    expect(nameOrNothing(HEX, { name: HEX })).toBeUndefined()
    expect(nameOrNothing(HEX, { name: HEX, nip05: 'rosa@x.test' })).toBe('@rosa')
  })
})
