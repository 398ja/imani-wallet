/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Does the terminal's actor actually reach `issueAndDeliver`?
 *
 * `MerchantHomePage` hides Sell from a redemption-only terminal, and
 * `issueAndDeliver` refuses it. Both were tested. The WIRING between them was
 * not, and it was broken: `SellPage` built `{ kind: 'owner', stallPubkey }`
 * unconditionally, so a terminal reaching /sell issued with the stall's full
 * authority and a revoked one could still mint. `RedeemPage` did the same,
 * which names the wrong recipient on a payment request.
 *
 * Asserted on the SOURCE, deliberately. Driving these forms in jsdom needs a
 * scanner, a currency and an amount, which makes the test about the form; and
 * a mocked `issueAndDeliver` would prove the mock was called, not that the
 * app's own route passes the prop. What actually went wrong here was a
 * hardcoded literal, so that literal is what is checked — a regression would
 * have to reintroduce exactly it.
 */

const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8')

describe('the money screens do not invent an owner', () => {
  for (const file of ['SellPage.tsx', 'RedeemPage.tsx']) {
    it(`${file} takes the actor rather than hardcoding one`, () => {
      const text = src(file)

      // The exact shape of the bug: an owner actor built with no fallback.
      expect(text).not.toMatch(/actor:\s*\{\s*kind:\s*'owner'/)
      // And the fix: the caller's actor, with the owner only as a default.
      expect(text).toMatch(/actor:\s*actor\s*\?\?\s*\{\s*kind:\s*'owner'/)
    })

    it(`${file} accepts an actor prop`, () => {
      expect(src(file)).toMatch(/actor\?:\s*Actor/)
    })
  }

  it('App passes the terminal actor to both', () => {
    // The other half: a screen that accepts the prop but is never given it
    // would behave exactly as the bug did.
    const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8')
    const sell = app.slice(app.indexOf('<SellPage'), app.indexOf('<SellPage') + 300)
    const redeem = app.slice(app.indexOf('<RedeemPage'), app.indexOf('<RedeemPage') + 300)

    expect(sell).toMatch(/actor=\{terminal\.actor/)
    expect(redeem).toMatch(/actor=\{terminal\.actor/)
  })

  it('SellPage also carries the session, so a lapsed till cannot issue', () => {
    // Role alone is not enough: a full till whose day rolled over still passes
    // `mayIssue`. `issueAndDeliver` needs the session to refuse it.
    expect(src('SellPage.tsx')).toMatch(/session,/)
    const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8')
    const sell = app.slice(app.indexOf('<SellPage'), app.indexOf('<SellPage') + 300)
    expect(sell).toMatch(/session=\{terminal\.session\}/)
  })
})
