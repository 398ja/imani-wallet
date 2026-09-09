import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The wallet API must remain incapable of spending.
 *
 * [ADR 0002](../../../docs/adr/0002-the-api-plans-the-caller-signs.md) records
 * this as the property that makes a public spending endpoint defensible at all:
 * "the service has **no code path capable of spending**". Everything else about
 * this service — that it holds no key, stores nothing, couriers signatures it
 * cannot forge — is downstream of it.
 *
 * The risk is not that someone sets out to break it. It is that an endpoint
 * gains a signer for a perfectly good local reason (a test helper promoted to
 * production, a convenience wrapper, a copied snippet) and no endpoint's own
 * tests fail, because signing is exactly what that endpoint now does correctly.
 *
 * ## Why this checks CALLS and not imports
 *
 * The obvious check — "the service imports nothing that can sign" — is
 * unsatisfiable, and finding that out is what this test is worth.
 * `nip98.ts` imports `schnorr` from `@noble/curves` to VERIFY the caller's
 * signature, and that same object exposes `.sign`. The service cannot
 * authenticate anyone without it.
 *
 * So the boundary is not which module is imported but which operation is
 * invoked. `schnorr.verify` is the service's whole job; `schnorr.sign` would be
 * the end of the argument in ADR 0002. The same distinction applies to
 * `nostr-tools`, which is imported for its `Event` TYPE only — types are erased,
 * so that import cannot become a runtime capability.
 *
 * ## What this cannot catch
 *
 * A signer reached dynamically — `await import(...)`, or indirection through a
 * dependency's own re-export. That is a real limit and is stated rather than
 * papered over: this is a tripwire against the accident that is likely, not a
 * proof against an adversary with commit access. The Dockerfile carries the
 * same kind of assertion for `@imani/voucher-send`, and for the same reason.
 */

const DIR = join(__dirname, '..')

/** Every source file the service actually ships. Tests are not runtime. */
const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .map((file) => ({ file, text: readFileSync(join(DIR, file), 'utf8') }))

/**
 * Operations that produce a signature or spend a proof.
 *
 * Each is a CALL, written as it would appear. `finalizeEvent` is nostr-tools'
 * one-shot sign-and-seal; `getSignature` and `signEvent` are its older forms.
 */
const SPENDING_CALLS: Array<[RegExp, string]> = [
  [/\bschnorr\s*\.\s*sign\s*\(/, 'schnorr.sign — signs; the service may only verify'],
  [/\bfinalizeEvent\s*\(/, 'finalizeEvent — signs and seals a Nostr event'],
  [/\bgetSignature\s*\(/, 'getSignature — signs a Nostr event'],
  [/\bsignEvent\s*\(/, 'signEvent — signs a Nostr event'],
  [/\bgenerateSecretKey\s*\(/, 'generateSecretKey — the service must hold no key'],
  [/\bgeneratePrivateKey\s*\(/, 'generatePrivateKey — the service must hold no key'],
  [/\bnip04\s*\.\s*encrypt\s*\(/, 'nip04.encrypt — needs a private key'],
  [/\bnip44\s*\.\s*encrypt\s*\(/, 'nip44.encrypt — needs a private key'],
]

/** Comments and strings describe the rule; only code can break it. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""')
}

describe('the wallet API cannot spend', () => {
  it('finds the service source, so this is not vacuously passing', () => {
    // Without this, a rename of the directory would turn every check below
    // into "no files, no violations, all green".
    expect(sources.length).toBeGreaterThan(5)
    expect(sources.map((s) => s.file)).toContain('server.ts')
  })

  it('invokes no operation that signs or spends', () => {
    const found: string[] = []
    for (const { file, text } of sources) {
      const body = code(text)
      for (const [pattern, why] of SPENDING_CALLS) {
        // Named, not counted: a failure has to say what to remove.
        if (pattern.test(body)) found.push(`${file}: ${why}`)
      }
    }
    expect(found).toEqual([])
  })

  it('verifies signatures, which is the capability it does need', () => {
    // The positive half. Asserting only the absence would also pass if the
    // service stopped authenticating callers altogether.
    const nip98 = sources.find((s) => s.file === 'nip98.ts')
    expect(nip98).toBeDefined()
    expect(/\bschnorr\s*\.\s*verify\s*\(/.test(nip98!.text)).toBe(true)
  })

  it("imports nostr-tools' root only as a type, and its pool only for relays", () => {
    /**
     * The root `nostr-tools` export includes `finalizeEvent` and
     * `generateSecretKey`, so a VALUE import of it would put a signer one
     * autocomplete away. It is imported for the `Event` type alone, and types
     * are erased at build.
     *
     * `nostr-tools/pool` is different and the distinction is measured rather
     * than assumed: its entire export surface is `SimplePool`,
     * `AbstractSimplePool` and `useWebSocketImplementation` — relay plumbing,
     * with nothing that signs. The first version of this test asserted every
     * nostr-tools import must be `import type` and failed on that subpath,
     * which would have meant either a false alarm forever or reading the
     * service's relay reads as a spending capability.
     */
    const RELAY_ONLY = ['SimplePool', 'AbstractSimplePool', 'useWebSocketImplementation']

    for (const { file, text } of sources) {
      for (const line of text.split('\n')) {
        if (!/from ['"]nostr-tools/.test(line)) continue
        if (line.trimStart().startsWith('import type')) continue

        const subpath = /from ['"]nostr-tools\/pool['"]/.test(line)
        expect(subpath, `${file}: value import of nostr-tools root — ${line.trim()}`).toBe(true)

        const named = line.match(/\{([^}]*)\}/)?.[1] ?? ''
        for (const symbol of named.split(',').map((s) => s.trim()).filter(Boolean)) {
          expect(RELAY_ONLY, `${file}: ${symbol} is not relay plumbing`).toContain(symbol)
        }
      }
    }
  })

  it('detects a signing call when one is introduced', () => {
    // The mutation control, run in-process rather than by editing a file: the
    // assertions above are only worth their runtime if this pattern set would
    // actually fire. Without it, a typo in every regex would look like a pass.
    const planted = 'const e = finalizeEvent(template, sk)'
    const hits = SPENDING_CALLS.filter(([p]) => p.test(planted))
    expect(hits.length).toBe(1)
    expect(hits[0][1]).toMatch(/finalizeEvent/)
  })

  it('is not fooled by the word appearing in a comment or a string', () => {
    // This file, and the README, both discuss `finalizeEvent` in prose. A check
    // that flagged them would be turned off within a week.
    const prose = `
      // we must never call finalizeEvent(x)
      /* schnorr.sign( is forbidden */
      const message = "do not use generateSecretKey()"
    `
    const body = code(prose)
    expect(SPENDING_CALLS.some(([p]) => p.test(body))).toBe(false)
  })
})
