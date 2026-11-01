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

/**
 * The NAP signer popup's location (#411), split out: it is the one wallet page with different
 * headers on purpose, and gets its own assertions below.
 */
const signerBlock = /location = \/nap\/signer \{[\s\S]*?\n {4}\}/.exec(conf)?.[0] ?? ''
const appConf = conf.replace(signerBlock, '')

const policies = [...appConf.matchAll(/add_header Content-Security-Policy "([^"]+)"/g)].map(
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
    // The one addition is Google Identity Services' library, by full URL, for the Drive
    // backup (#311): a single file Google serves, not a host or a wildcard.
    const scriptSrc = /script-src ([^;]+)/.exec(policies[i])?.[1]
    expect(scriptSrc).toBe("'self' https://accounts.google.com/gsi/client")
  })

  it.each([0, 1])('admits Google Identity Services frames and nothing else (policy %i)', (i) => {
    // default-src 'none' would refuse the GIS iframe; frame-src names only its /gsi/ path.
    const frameSrc = /frame-src ([^;]+)/.exec(policies[i])?.[1]
    expect(frameSrc).toBe('https://accounts.google.com/gsi/')
  })

  it.each([0, 1])('reaches the Drive API (policy %i)', (i) => {
    // src/lib/drive.ts fetches www.googleapis.com; connect-src https: covers it.
    const connectSrc = /connect-src ([^;]+)/.exec(policies[i])?.[1]
    expect(connectSrc?.split(' ')).toContain('https:')
  })
})

describe('deploy/nginx.conf Cross-Origin-Opener-Policy', () => {
  // The GIS token flow watches the account chooser it opened with window.open. Under
  // `same-origin` that handle is severed and GIS reports popup_closed at once (#311).
  const coops = [...appConf.matchAll(/add_header Cross-Origin-Opener-Policy "([^"]+)"/g)].map(
    (m) => m[1],
  )

  it('lets the Google account chooser popup report back, on every app location', () => {
    expect(coops).toEqual(['same-origin-allow-popups', 'same-origin-allow-popups'])
  })
})

describe('deploy/nginx.conf /nap/signer (#411, NAP extension 0002)', () => {
  const header = (name: string) => new RegExp(`add_header ${name} "([^"]+)"`).exec(signerBlock)?.[1]

  it('exists, and serves the app shell in place (no redirect into the stricter index.html block)', () => {
    expect(signerBlock).not.toBe('')
    expect(signerBlock).toContain('try_files /index.html =404;')
  })

  it('keeps window.opener: COOP unsafe-none, or the site that opened it never hears back', () => {
    expect(header('Cross-Origin-Opener-Policy')).toBe('unsafe-none')
  })

  it('is never framed: consent in a frame can be clickjacked', () => {
    expect(header('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(header('X-Frame-Options')).toBe('DENY')
  })

  it('runs only our own script, and talks to nothing but its own origin', () => {
    const csp = header('Content-Security-Policy') ?? ''
    expect(/script-src ([^;]+)/.exec(csp)?.[1]).toBe("'self'")
    expect(/connect-src ([^;]+)/.exec(csp)?.[1]).toBe("'self'")
    expect(/default-src ([^;]+)/.exec(csp)?.[1]).toBe("'none'")
  })
})
