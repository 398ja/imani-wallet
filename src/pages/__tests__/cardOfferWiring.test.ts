/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Does connecting Stripe actually publish that the stall takes cards?
 *
 * `reconcileCardOffer` is tested, `stripeAccount` is tested, and the WIRING
 * between them is the whole feature: for the entire life of this code the
 * function existed with no caller, so `acceptsCards` was never published, no
 * Buy button ever rendered, and every other piece of the purchase path — direct
 * charges, the debt queue, the issuer — could not run. That is not a bug a unit
 * test finds, because each unit was correct.
 *
 * Asserted on the SOURCE, following `sellActorWiring`. Driving this component
 * needs a NAP session, a signer, a relay and a router; mocking all four would
 * prove the mocks were called rather than that a merchant connecting Stripe
 * ends up published as taking cards.
 */
const source = readFileSync(
  join(process.cwd(), 'src/pages/PaymentsSettingsPage.tsx'),
  'utf8',
)

describe('the card offer is published from the settings screen', () => {
  it('reconciles and publishes, rather than only reading a status', () => {
    expect(source).toContain('reconcileCardOffer')
    expect(source).toContain('buildMerchantEvent')
    expect(source).toContain('publish(signed)')
  })

  it('reconciles on EVERY path, not just after connecting', () => {
    // Connect, refresh, disconnect and the plain read on mount all end in
    // `apply`. A stall whose Stripe was disabled while they were away has the
    // offer withdrawn next time they look, which only happens because the mount
    // read goes through the same function.
    for (const call of ['connectStripe', 'refreshStripe', 'disconnectStripe', 'fetchStripeStatus']) {
      expect(source, `${call} must flow through apply()`).toContain(call)
    }
    // One reconcile, reached by all of them, rather than four call sites where
    // one can be forgotten.
    expect(source.match(/reconcileCardOffer\(/g)).toHaveLength(1)
  })

  it('reads the live record rather than a mounted closure', () => {
    // `apply` publishes and hands a NEW record up. Reading `merchant` from a
    // closure meant the second action of a session compared against the record
    // as it was on mount: connect then disconnect would find acceptsCards still
    // false, decide nothing changed, and leave a stall publicly offering cards
    // it had just switched off.
    expect(source).toContain('current.current')
    expect(source).not.toMatch(/reconcileCardOffer\(\s*merchant\s*,/)
  })

  it('does not republish when the status could not be read', () => {
    // Unknown changes nothing, the same rule as an unreachable gateway when
    // confirming issuance. Withdrawing a working stall's offer over a blip
    // would take them out of business for the length of an outage.
    // The early return has to come BEFORE the reconcile, so slice from the
    // callback rather than from the first `useEffect` — there is one above it
    // that keeps the record ref current.
    const applyBody = source.slice(
      source.indexOf('const apply = useCallback('),
      source.indexOf('reconcileCardOffer('),
    )
    expect(applyBody).toMatch(/result\.kind !== 'ok'[\s\S]*?return/)
  })

  it('never leaves the screen stuck busy', () => {
    // getSigner() throws on a locked session. Without a finally this escaped
    // the handler and left every button disabled with nothing explaining why.
    expect(source).toContain('} finally {')
    expect(source).toContain('setBusy(false)')
  })

  it('asks before it stops sales, without a native dialog', () => {
    // window.confirm is the one piece of UI this app cannot style, animate, or
    // make legible in dark mode, and TerminalsPage already asks its destructive
    // question inline.
    // Asserted on the CODE, not the file: the comment above the panel names
    // `window.confirm` to say why it is not used, and a bare text search reads
    // that as the thing it warns against.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toContain('window.confirm')
    expect(code).toContain('setConfirming(true)')
  })
})
