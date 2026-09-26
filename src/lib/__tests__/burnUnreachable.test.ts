import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * `TokenRedemption.burn()` is unreachable in this app, and must stay so until
 * it files a claim (#95).
 *
 * The vendored `shared/tokenRedemption.js` burns a coupon instead of saving it
 * when `isSelfIssuedToken(issuer, me)` is true. `burn()` writes NO local row,
 * so a coupon coming home to its stall that way would never reach
 * `legacyBridge.stampCorrelation`, and the claimed figure #90 fixed would be
 * silently wrong again. It is dormant only because the branch is guarded by
 * `typeof isSelfIssuedToken === 'function'` and nothing this app loads
 * defines that global. Both halves are pinned here, so loading such a script
 * fails this test rather than quietly dropping claims.
 */

/** Every legacy script `legacyBridge` loads, by its `?url` import. */
function loadedScripts(): string[] {
  const bridge = readFileSync('src/lib/legacyBridge.ts', 'utf8')
  const urls = [...bridge.matchAll(/from '\.\.\/\.\.\/(shared\/[^']+\.js)\?url'/g)].map((m) => m[1])
  return urls
}

describe('burn() in the vendored redemption script', () => {
  it('is entered only through a typeof-guarded isSelfIssuedToken', () => {
    const source = readFileSync('shared/tokenRedemption.js', 'utf8')
    const calls = [...source.matchAll(/this\.burn\(/g)]
    expect(calls).toHaveLength(1)
    expect(source).toMatch(
      /typeof isSelfIssuedToken === 'function' && isSelfIssuedToken\([^)]*\)\) \{\s*[^\n]*\n\s*return await this\.burn\(/,
    )
  })

  it('stays dormant: no script the app loads defines isSelfIssuedToken', () => {
    const scripts = loadedScripts()
    // Guard against the regex silently matching nothing.
    expect(scripts).toContain('shared/tokenRedemption.js')
    for (const path of scripts) {
      const source = readFileSync(path, 'utf8')
      expect(source, path).not.toMatch(
        // A declaration or an assignment; `=(?!=)` so the guard's own
        // `typeof isSelfIssuedToken === 'function'` is not mistaken for one.
        /function\s+isSelfIssuedToken\b|isSelfIssuedToken\s*=(?!=)/,
      )
    }
  })
})
