/**
 * The witness signer must be installed wherever the api client is obtained.
 *
 * Issue #58. `shared/api.js` reads `globalThis.__imaniWitnessHeaderForToken`
 * to sign locked proofs on receive and on atomic send. It is a classic script
 * and cannot import the TypeScript signer, so `legacyApi()` hands it over as a
 * global.
 *
 * That makes the wiring positional rather than typed: if a caller reaches the
 * api client without going through `legacyApi()`, or if the install line is
 * moved or dropped in a refactor, nothing fails to compile and no unit test
 * that stubs the hook notices. The wallet simply stops signing, and a locked
 * coupon becomes unspendable with the mint reporting a missing signature.
 *
 * `atomicSendWitnesses.test.ts` covers what api.js does WITH the hook
 * installed; this covers that production actually installs it. Neither
 * subsumes the other — that test passes against a build where nothing ever
 * calls the installer.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const bridge = readFileSync(new URL('../legacyBridge.ts', import.meta.url), 'utf8')
const pay = readFileSync(new URL('../pay.ts', import.meta.url), 'utf8')

describe('the witness signer hook', () => {
  it('is installed by legacyApi, the one function that hands out the api client', () => {
    // Asserted on the source because the alternative is booting the whole
    // classic-script stack — jsdom, localStorage, NIP-98 credentials — which
    // would test the harness more than the wiring.
    const legacyApiBody = bridge.slice(bridge.indexOf('export async function legacyApi'))
    const bodyUpToNextExport = legacyApiBody.slice(0, legacyApiBody.indexOf('\nexport ', 1))

    expect(bodyUpToNextExport).toContain('__imaniWitnessHeaderForToken')
    expect(bodyUpToNextExport).toContain('witnessHeaderForToken')
  })

  it('is installed before the client is returned, not after', () => {
    // Order matters: a caller receives the client and may use it immediately.
    const body = bridge.slice(bridge.indexOf('export async function legacyApi'))
    const install = body.indexOf('__imaniWitnessHeaderForToken')
    const ret = body.indexOf('return window.api')

    expect(install).toBeGreaterThan(-1)
    expect(ret).toBeGreaterThan(-1)
    expect(install).toBeLessThan(ret)
  })

  it('is on the send path too, which reaches the client through legacyApi', () => {
    // Both send paths — single and bundle — go through sendApi(), so the hook
    // is installed for them as well. If sendApi ever stops calling legacyApi,
    // sends would silently go out unsigned while receives kept working.
    const sendApiBody = pay.slice(pay.indexOf('async function sendApi'))
    expect(sendApiBody.slice(0, sendApiBody.indexOf('}'))).toContain('legacyApi()')
  })

  it('has exactly one installer, so there is one place that decides what we sign', () => {
    const installs = bridge.match(/__imaniWitnessHeaderForToken\s*=/g) ?? []
    expect(installs).toHaveLength(1)
  })
})
