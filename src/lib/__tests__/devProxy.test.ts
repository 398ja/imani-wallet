/**
 * @vitest-environment node
 *
 * The dev proxy points at services that exist.
 *
 * ## Why this is a test and not a code review item
 *
 * Two rules for the card-payment work were added with STAGING ports — 8087 and
 * 8086, the numbers `imani-deploy` publishes — in a table where every other
 * entry targets the local test stack in the 280xx range. On a developer's
 * machine 8087 is nothing, so every checkout failed with ECONNREFUSED against a
 * service that was running the whole time, two digits away.
 *
 * Nothing could catch that. The proxy is dev-server configuration: it is not
 * imported by the app, not exercised by any suite, and a wrong target produces
 * a runtime network error in a browser rather than a failure in CI. It was
 * found by a reviewer reading the table, which is not a repeatable process.
 *
 * ## The worse version of the same bug
 *
 * The obvious correction to `8086` is `28086` — same number, local range. That
 * is WORSE than the original: on the test stack 28086 is `bottin-api`, a live
 * and healthy service that knows nothing about Stripe. A refused connection
 * sends you to the proxy table; a 404 from a real service sends you into the
 * wrong repository.
 *
 * So this asserts the specific ports, cross-checked against
 * `imani-deploy/docker-compose.test.yml`, rather than merely asserting the
 * range. Getting into the right range is not the property that matters.
 */
import { describe, expect, it } from 'vitest'

import { proxy } from '../../../vite.config'

/**
 * What the local test stack actually publishes, from
 * `imani-deploy/docker-compose.test.yml`. If a port moves there, this table
 * moves with it — and the mismatch shows up here rather than in a browser.
 */
const TEST_STACK: Record<number, string> = {
  28080: 'edge-proxy (nginx)',
  28081: 'gateway-core / account-app',
  28082: 'gateway-customer / customer-wallet',
  28084: 'gateway-portal',
  28086: 'bottin-api',
  28087: 'payment-adapter',
  28088: 'merchant-service',
  28186: 'cashback-claim',
  27777: 'imani-mint-rest',
}

function targets(): { rule: string; target: string; port: number }[] {
  return Object.entries(proxy as Record<string, { target?: string }>)
    .filter(([, value]) => typeof value?.target === 'string')
    .map(([rule, value]) => {
      const target = value.target as string
      return { rule, target, port: Number(new URL(target).port) }
    })
}

describe('the dev proxy table', () => {
  /*
   * The regression that prompted this file. A staging port here is not a
   * near-miss: it is a rule that can never work on the machine the table is
   * FOR, and it fails at the network layer where nothing explains why.
   */
  it('never points a rule at a service the local stack does not publish', () => {
    const strays = targets().filter(({ port }) => !(port in TEST_STACK))
    expect(strays.map((s) => `${s.rule} -> ${s.target}`)).toEqual([])
  })

  /*
   * Named explicitly, because the interesting failure is a rule that reaches a
   * DIFFERENT healthy service rather than nothing at all. Asserting the range
   * would have accepted merchant/stripe pointing at bottin-api.
   */
  it.each([
    ['/api/v1/checkout', 28087, 'payment-adapter'],
    ['/api/v1/merchant/stripe', 28088, 'merchant-service'],
  ])('routes %s to %i, which is %s', (rule, port, service) => {
    const found = targets().find((t) => t.rule === rule)
    expect(found, `${rule} has no proxy rule`).toBeDefined()
    expect(found!.port, `${rule} must reach ${service}`).toBe(port)
    expect(TEST_STACK[found!.port]).toBe(service)
  })

  /*
   * changeOrigin rewrites the Host header, and a NIP-98 signature covers the
   * `u` tag — the origin the browser signed. Flip it on an authenticated route
   * and the signature verifies against the wrong URL, which the gateway reports
   * as a bad signature and nothing in that message mentions a proxy. The file's
   * own header comment warns about this, so it is asserted rather than trusted.
   */
  it.each(['/api/v1/atomic-send', '/api/v1/nip05', '/api/v1/merchant/stripe'])(
    'keeps changeOrigin off for the origin-sensitive route %s',
    (rule) => {
      const entry = (proxy as Record<string, { changeOrigin?: boolean }>)[rule]
      expect(entry?.changeOrigin).toBe(false)
    },
  )

  /*
   * Prefix matching is longest-wins here, but the catch-all is the thing every
   * new rule exists to escape: falling into it is what sent purchases to
   * customer-wallet and merchant calls to gateway-portal's 403. A rule that
   * duplicates the catch-all's target is doing nothing.
   */
  it('gives every specific rule a target the catch-all would not have given it', () => {
    const all = targets()
    const catchAll = all.find((t) => t.rule === '/api')
    if (!catchAll) return
    const redundant = all.filter(
      (t) => t.rule !== '/api' && t.rule.startsWith('/api') && t.target === catchAll.target,
    )
    expect(redundant.map((r) => r.rule)).toEqual([])
  })
})
