import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'

/**
 * The image build refuses to ship a wallet that names no trusted mint
 * (imani-wallet#133 review, HIGH-1). The Dockerfile runs this script in the
 * builder stage, so these drive the script exactly as `docker build` does.
 */

function build(env: Record<string, string>) {
  const result = spawnSync('sh', ['scripts/check-trusted-mint-build.sh'], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

describe('scripts/check-trusted-mint-build.sh', () => {
  /** No mint at all: the build fails, and says which argument is missing. */
  it('fails when VITE_TRUSTED_MINT_URLS is unset', () => {
    const { status, out } = build({})
    expect(status).not.toBe(0)
    expect(out).toContain('VITE_TRUSTED_MINT_URLS is unset')
  })

  /** A value made only of separators and spaces names no mint either. */
  it('fails when VITE_TRUSTED_MINT_URLS names nothing', () => {
    expect(build({ VITE_TRUSTED_MINT_URLS: ' , ' }).status).not.toBe(0)
  })

  /** The staging value passes. */
  it('passes for a public mint URL', () => {
    const { status, out } = build({ VITE_TRUSTED_MINT_URLS: 'https://mint.staging.398ja.xyz' })
    expect(status).toBe(0)
    expect(out).toContain('https://mint.staging.398ja.xyz')
  })

  /** A migration list of two mints passes. */
  it('passes for a comma-separated list', () => {
    expect(build({ VITE_TRUSTED_MINT_URLS: 'https://mint.a.test, https://mint.b.test/cashu' }).status).toBe(0)
  })

  /**
   * An entry the wallet would silently drop (LOW-1) fails the build, rather than
   * shipping an image that trusts less than its builder thought.
   */
  it.each([
    ['userinfo', 'https://user:pw@mint.test'],
    ['a query', 'https://mint.test/?x=1'],
    ['a fragment', 'https://mint.test/#f'],
    ['a non-http scheme', 'ftp://mint.test'],
    ['no host', 'https:///cashu'],
  ])('fails for an entry with %s', (_name, url) => {
    expect(build({ VITE_TRUSTED_MINT_URLS: url }).status).not.toBe(0)
  })

  /** The explicit escape hatch for a throwaway local image, announced loudly. */
  it('passes with ALLOW_UNTRUSTED_MINT_BUILD=true, and warns', () => {
    const { status, out } = build({ ALLOW_UNTRUSTED_MINT_BUILD: 'true' })
    expect(status).toBe(0)
    expect(out).toContain('Never deploy it')
  })
})
