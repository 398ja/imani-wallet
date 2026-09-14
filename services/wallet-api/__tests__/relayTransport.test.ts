import { describe, expect, it } from 'vitest'

import { resolveRelayUrl as resolveWalletRelay } from '../stallLookup.js'
import { resolveRelayUrl as resolveAuditRelay } from '../../audit-api/server.js'

/**
 * IW-11 and its rollout.
 *
 * The finding is real: stall records and attestations read over a cleartext hop can be
 * WITHHELD, and an absent record is not a neutral outcome — it permits a send in one service
 * and produces a public accusation in the other.
 *
 * The first version of the fix threw on any non-wss URL. That was correct about the risk and
 * wrong about the rollout, because both Dockerfiles ship `ENV ..._RELAY_URL=ws://nostr-relay:7777`
 * — so the guard refused to start the very image it was added to protect. Verified by importing
 * the module with exactly that environment: the process died at module load.
 *
 * A security control that stops the service booting gets reverted wholesale, and the finding
 * comes back with it. These tests pin the graduated behaviour instead: loud everywhere, fatal
 * where the operator has declared production.
 */
describe('relay transport', () => {
  const both: Array<[string, (env: NodeJS.ProcessEnv) => string, string]> = [
    ['wallet-api', resolveWalletRelay, 'WALLET_API'],
    ['audit-api', resolveAuditRelay, 'AUDIT'],
  ]

  for (const [name, resolve, prefix] of both) {
    describe(name, () => {
      it('accepts the wss URL a production deployment should use', () => {
        expect(resolve({ [`${prefix}_RELAY_URL`]: 'wss://relay.imani.casa' } as NodeJS.ProcessEnv))
          .toContain('wss://relay.imani.casa')
      })

      it('starts on the cleartext URL the shipped image sets, rather than refusing to boot', () => {
        // The exact value in services/*/Dockerfile. If this throws, the container does not start.
        expect(() =>
          resolve({ [`${prefix}_RELAY_URL`]: 'ws://nostr-relay:7777' } as NodeJS.ProcessEnv),
        ).not.toThrow()
      })

      it('refuses cleartext once the operator declares production', () => {
        expect(() =>
          resolve({
            [`${prefix}_RELAY_URL`]: 'ws://nostr-relay:7777',
            NODE_ENV: 'production',
          } as NodeJS.ProcessEnv),
        ).toThrow(/must be wss:\/\/ in production/)
      })

      it('permits cleartext in production only behind the explicit opt-out', () => {
        expect(() =>
          resolve({
            [`${prefix}_RELAY_URL`]: 'ws://nostr-relay:7777',
            NODE_ENV: 'production',
            [`${prefix}_ALLOW_PLAINTEXT_RELAY`]: 'true',
          } as NodeJS.ProcessEnv),
        ).not.toThrow()
      })

      it('refuses an unset relay outside tests: there is no safe default', () => {
        expect(() => resolve({} as NodeJS.ProcessEnv)).toThrow(/must be set/)
      })
    })
  }
})
