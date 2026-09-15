import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The CSP this container ships must not break the camera.
 *
 * qr-scanner decodes in a Web Worker it builds from a Blob URL. Under
 * `worker-src 'self'` the browser refuses that worker, and the failure is
 * silent in the only way that matters: the camera opens, the preview runs, the
 * scan region even highlights — and no code is ever decoded. Every scan on
 * staging did nothing, for a NIP-05 handle and a `vreqA…` payment request
 * alike, because neither reached the router in ScanPage.
 *
 * Two CSP headers INTERSECT rather than override, so the edge already sending
 * `worker-src 'self' blob:` (imani-deploy) could not rescue this one. That is
 * why the assertion lives here, against this repo's own file: the header that
 * broke scanning is the strictest of the two, and it is this one.
 *
 * The allowance is narrow. `script-src 'self'` still bars injected script, so
 * the only code that can create the blob is our own bundle.
 */
const conf = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8')

const policies = [...conf.matchAll(/add_header Content-Security-Policy "([^"]+)"/g)].map(
  (m) => m[1],
)

describe('deploy/nginx.conf Content-Security-Policy', () => {
  it('is served by every location that serves the app', () => {
    // index.html and the SPA fallback. nginx add_header inheritance is
    // all-or-nothing per level, so a policy on one is not on the other.
    expect(policies).toHaveLength(2)
  })

  it.each([0, 1])('allows the qr-scanner blob worker (policy %i)', (i) => {
    const workerSrc = /worker-src ([^;]+)/.exec(policies[i])?.[1]
    expect(workerSrc).toBeDefined()
    expect(workerSrc).toContain('blob:')
  })

  it.each([0, 1])('still refuses injected script (policy %i)', (i) => {
    // The blob allowance is only safe while this holds: no 'unsafe-inline' and
    // no blob: in script-src, so nothing an attacker injects can run or be
    // packaged into the worker.
    const scriptSrc = /script-src ([^;]+)/.exec(policies[i])?.[1]
    expect(scriptSrc).toBe("'self'")
  })
})
