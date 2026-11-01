/**
 * @vitest-environment jsdom
 *
 * The terminal confirm and cancel calls, held against the gateway's NIP-98 rules.
 *
 * imani-wallet 0.14.1 sent `POST .../confirm` and `POST .../cancel` with no body. nip98.ts only
 * adds a `payload` tag when there is a body, and imani-security's `Nip98AuthFilter` refuses
 * every write method without one ("NIP-98 payload tag required for POST"). So on staging every
 * terminal enrolled after gateway-customer V27 stayed unconfirmed and could never sell.
 *
 * The unit tests never noticed because they faked the call one level above the signer. These
 * run the REAL wallet signer and the REAL `signedFetch`, and capture only what would have gone
 * on the wire. A port of the server's checks then judges it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

import { createWalletSigner } from '../signer'
import { nip98Refusal, type WireRequest } from './nip98ServerCheck'

// The stall's session signer. The real wallet signer, built from a fresh key; only the
// session lookup is replaced, because a test has no unlocked wallet.
const stallSigner = createWalletSigner(bytesToHex(generateSecretKey()))
vi.mock('../nap', () => ({ getSigner: () => stallSigner }))

const { stallConfirm, deviceConfirm } = await import('../terminalConfirm')
const { releasePending } = await import('../terminalRevoke')

let sent: WireRequest[] = []

beforeEach(() => {
  sent = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    sent.push({
      url: new URL(input, window.location.origin).toString(),
      method: init.method ?? 'GET',
      authorization: headers.get('Authorization'),
      contentType: headers.get('Content-Type'),
      body: typeof init.body === 'string' ? init.body : '',
    })
    return new Response(null, { status: 204 })
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('terminal credential confirm and cancel pass the gateway NIP-98 filter', () => {
  // The owner's app confirming as the stall. This is the call staging refused with 401.
  it('the stall confirm', async () => {
    expect(await stallConfirm('v-1')).toBe(204)

    expect(sent).toHaveLength(1)
    expect(nip98Refusal(sent[0])).toBeNull()
    expect(sent[0].contentType).toBe('application/json')
  })

  // The new device confirming with its own key during setup.
  it('the device confirm', async () => {
    const terminal = createWalletSigner(bytesToHex(generateSecretKey()))
    await deviceConfirm('v-2', terminal)

    expect(sent).toHaveLength(1)
    expect(sent[0].url).toMatch(/\/terminal-credentials\/v-2\/confirm$/)
    expect(nip98Refusal(sent[0])).toBeNull()
    expect(sent[0].contentType).toBe('application/json')
  })

  // The owner cancelling a waiting credential, so its pending slot frees at once.
  it('the stall cancel', async () => {
    await releasePending('v-3')

    expect(sent).toHaveLength(1)
    expect(sent[0].url).toMatch(/\/terminal-credentials\/v-3\/cancel$/)
    expect(nip98Refusal(sent[0])).toBeNull()
    expect(sent[0].contentType).toBe('application/json')
  })
})

describe('the server check itself', () => {
  // The check must refuse the exact request 0.14.1 sent, or the tests above prove nothing.
  it('refuses a signed POST with no payload tag, as staging did', async () => {
    const { signedFetch } = await import('../nip98')
    await signedFetch('/api/v1/x', 'POST')

    expect(nip98Refusal(sent[0])).toBe('NIP-98 payload tag required for POST')
  })

  // And a body that is not the one that was signed.
  it('refuses a payload tag that does not match the body', async () => {
    const { signedFetch } = await import('../nip98')
    await signedFetch('/api/v1/x', 'POST', { a: 1 })

    expect(nip98Refusal({ ...sent[0], body: '{"a":2}' })).toBe('NIP-98 payload hash mismatch')
  })
})
