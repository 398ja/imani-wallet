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

import { EDGE_AUTH_PREFIXES, proxy } from '../../../vite.config'

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
  /*
   * The failure this file did NOT catch, three times.
   *
   * Every test above validates rules that EXIST. None notices one that is
   * absent — and absence is the failure mode that keeps happening, because
   * `/api` has a catch-all: a path with no rule does not error, it quietly
   * reaches customer-wallet and 404s. Comments in vite.config.ts record the
   * same discovery for incoming-notifications and for push subscriptions; the
   * third was payment-receipts, where the symptom was a settlement
   * notification that never arrived and the cause was one missing line.
   *
   * So this pins the direction the catch-all hides: every gateway-core API the
   * wallet calls must have its own rule.
   */
  it('routes every gateway-core path the wallet calls, since the catch-all hides a missing rule', () => {
    // Paths served by gateway-core-rest, NOT customer-wallet. Add to this list
    // when the wallet starts calling a new one.
    const GATEWAY_CORE_PATHS = [
      '/api/v1/atomic-send',
      '/api/v1/incoming-notifications',
      '/api/v1/payment-receipts',
      '/api/v1/nip05',
    ]

    // Must resolve to a rule whose TARGET is gateway-core. Checking only that
    // "some rule matches" is worthless here: the `/api` catch-all matches
    // every one of these, which is precisely how a missing rule stays
    // invisible. The first draft of this test did exactly that and passed
    // against the bug it was written for.
    const entries = Object.entries(proxy as Record<string, { target?: string }>)
    const unrouted = GATEWAY_CORE_PATHS.filter((path) => {
      // Longest matching prefix wins, which is how the dev server resolves it.
      const match = entries
        .filter(([rule]) => path === rule || path.startsWith(rule + '/'))
        .sort((a, b) => b[0].length - a[0].length)[0]
      return !match || new URL(match[1].target as string).port !== '28081'
    })

    expect(unrouted).toEqual([])
  })

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

/**
 * The edge hop, which is a separate property from the target.
 *
 * `Connect to Stripe` answered 401 with a valid session AFTER the port was
 * fixed. The rule pointed at the right service and skipped the middleware that
 * turns a session cookie into `X-Auth-Pubkey`, so the request arrived
 * anonymous. Nothing looked wrong: a proxy rule with a correct target looks
 * finished, and the missing piece lives in a different part of the file.
 *
 * These tests pair the two halves so they cannot drift. Adding an
 * edge-authenticated route now means adding it to both, and forgetting either
 * is a failure here rather than a 401 nobody can explain.
 */
describe('edge-authenticated routes', () => {
  /*
   * The regression, stated directly. A prefix the middleware authenticates must
   * be a prefix the proxy routes, or the headers are attached to a request that
   * then goes somewhere else entirely.
   */
  it.each(EDGE_AUTH_PREFIXES)('has a proxy rule for the edge-auth prefix %s', (prefix) => {
    expect(Object.keys(proxy)).toContain(prefix)
  })

  /*
   * And the converse, which is the half that actually broke. Both services
   * behind these rules identify a caller ONLY from the edge-injected pubkey:
   * gateway-portal and merchant-service each reject an unproven header outright
   * (merchant-service does now — it used to trust it from anyone, which is why
   * this went unnoticed). A rule here that the middleware does not cover is a
   * screen that cannot work.
   */
  it.each(['/api/v1/portal', '/api/v1/merchant/stripe'])(
    'runs the edge-auth middleware for the session-authenticated rule %s',
    (rule) => {
      expect(EDGE_AUTH_PREFIXES).toContain(rule)
    },
  )

  /*
   * The secret is what makes the two headers believable, so a rule that sets
   * neither is one where the service falls back to "no identity". Asserted by
   * driving the `configure` hook rather than by reading the source, because the
   * property is what the proxy DOES to an outgoing request.
   */
  it.each(EDGE_AUTH_PREFIXES)('attaches the edge secret on %s, but only to a validated pubkey', (prefix) => {
    const entry = (proxy as Record<string, { configure?: (p: unknown) => void }>)[prefix]
    expect(entry?.configure, `${prefix} has no proxyReq hook`).toBeTypeOf('function')

    const run = (headers: Record<string, string>) => {
      const sent: Record<string, string> = { ...headers }
      let handler: ((req: unknown) => void) | undefined
      entry!.configure!({ on: (_e: string, cb: (req: unknown) => void) => (handler = cb) })
      handler!({
        getHeader: (name: string) => sent[name],
        setHeader: (name: string, value: string) => (sent[name] = value),
        removeHeader: (name: string) => delete sent[name],
      })
      return sent
    }

    // Validated: vouch for it.
    expect(run({ 'x-auth-pubkey': 'abc' })['X-Edge-Auth']).toBeTruthy()

    // Not validated: no secret, and the page's own permissions header is
    // dropped rather than forwarded to be refused later. Fail closed here, not
    // one layer down.
    const unauthenticated = run({ 'x-auth-permissions': 'coupon:issue' })
    expect(unauthenticated['X-Edge-Auth']).toBeUndefined()
    expect(unauthenticated['x-auth-permissions']).toBeUndefined()
  })
})
