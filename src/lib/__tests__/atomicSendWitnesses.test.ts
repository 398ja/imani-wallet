/**
 * Does the REAL api.js put the sender's witnesses on the wire?
 *
 * Issue #58. Sending a locked coupon spends it, so the mint demands a NUT-11
 * witness for every locked input. The gateway holds no customer spending keys,
 * so the signature is made in the page and travels with the request.
 *
 * This drives `shared/api.js` itself rather than a reimplementation. The whole
 * question is what that file puts on the wire, and a stub of it would answer a
 * different question — the same substitution the e2e probes exist to avoid.
 *
 * The bearer case matters as much as the locked one: an ordinary send must be
 * byte-identical to what it was before locked coupons existed, so the field is
 * omitted rather than sent as null.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it, beforeEach } from 'vitest'

interface CapturedRequest {
  body: Record<string, unknown> | null
}

/**
 * Loads the real classic script with the globals it expects.
 *
 * `NostrUtils` is stubbed because api.js refuses to send without NIP-98
 * credentials — the auth path is not what this test is about, and without the
 * stub every request throws before reaching fetch, which silently turns every
 * assertion below into a vacuous pass.
 */
function loadApi(captured: CapturedRequest) {
  const scope = globalThis as unknown as Record<string, unknown>
  scope.window = scope
  scope.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  scope.GatewayConfig = { relayUrl: 'wss://r', apiUrl: 'http://gw', gatewayUrl: 'http://gw' }
  scope.NostrUtils = { createNip98AuthHeader: async () => 'Nostr stub' }
  scope.fetch = async (_url: string, opts: { body?: string }) => {
    captured.body = opts?.body ? JSON.parse(opts.body) : null
    return {
      ok: true, status: 202,
      headers: { get: () => 'application/json' },
      json: async () => ({ send_id: 'x' }),
      text: async () => '{"send_id":"x"}',
    }
  }
  new Function(readFileSync(new URL('../../../shared/api.js', import.meta.url), 'utf8'))()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = scope.api as any
  api.setNostrCredentials('a'.repeat(64), '1'.repeat(64))
  return api
}

const PARAMS = { token: 'cashuBxyz', amount: 60, recipientPubkey: `02${'a'.repeat(64)}` }

describe('initiateAtomicSend witnesses', () => {
  let captured: CapturedRequest
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any

  beforeEach(() => {
    captured = { body: null }
    api = loadApi(captured)
  })

  it('carries the signatures in the BODY when the coupon is locked', async () => {
    // The body, not a header: the saga finishes on an async worker long after
    // the request is gone, so the server persists these with the send.
    ;(globalThis as Record<string, unknown>).__imaniWitnessHeaderForToken = () =>
      JSON.stringify({ sec: ['deadbeef'] })

    await api.initiateAtomicSend(PARAMS)

    expect(captured.body).not.toBeNull()
    expect(captured.body!.witnesses).toBe('{"sec":["deadbeef"]}')
  })

  it('omits the field entirely for a bearer coupon', async () => {
    ;(globalThis as Record<string, unknown>).__imaniWitnessHeaderForToken = () => null

    await api.initiateAtomicSend(PARAMS)

    expect(captured.body).not.toBeNull()
    expect('witnesses' in captured.body!).toBe(false)
  })

  it('omits the field when no signer is installed at all', async () => {
    // A wallet that has not loaded the bridge yet. Optional chaining, not a
    // crash.
    delete (globalThis as Record<string, unknown>).__imaniWitnessHeaderForToken

    await api.initiateAtomicSend(PARAMS)

    expect('witnesses' in captured.body!).toBe(false)
  })

  it('does not let a failing signer break the send', async () => {
    // An unsigned locked proof is refused by the MINT, with a reason naming
    // the real problem. Throwing here would also break every bearer send that
    // never needed a witness.
    ;(globalThis as Record<string, unknown>).__imaniWitnessHeaderForToken = () => {
      throw new Error('signer exploded')
    }

    await expect(api.initiateAtomicSend(PARAMS)).resolves.toBeDefined()
    expect('witnesses' in captured.body!).toBe(false)
  })
})
