import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The service images copy a few wallet files (`src/lib/...`) one by one, not the whole tree. A
 * copied file that gains a relative import of a file the image does not copy builds green in the
 * wallet and breaks the image: v0.55.3's purchase-issuer build failed its load check on
 * `voucherToken.ts -> ./plainToken`. This reads each runtime stage's COPY lines and checks every
 * relative VALUE import of a copied wallet file is copied too. `import type` is erased at run time
 * (tsx strips it), so it does not count.
 */
const ROOT = join(__dirname, '..', '..', '..')
const IMAGES = ['purchase-issuer', 'subscription', 'wallet-api', 'audit-api']

/** Repo paths a Dockerfile's LAST stage copies from the build context (sources only, no `--from`). */
function copiedFiles(dockerfile: string): Set<string> {
  const text = readFileSync(join(ROOT, dockerfile), 'utf8')
  const lastStage = text.slice(text.lastIndexOf('\nFROM '))
  const out = new Set<string>()
  for (const line of lastStage.split('\n')) {
    const m = /^COPY\s+(?!--from)(.+)$/.exec(line.trim())
    if (!m) continue
    const parts = m[1].split(/\s+/).filter((p) => !p.startsWith('--'))
    for (const src of parts.slice(0, -1)) out.add(normalize(src))
  }
  return out
}

/** Relative modules `file` imports for their value (not `import type`, not `export type`). */
function valueImports(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const out: string[] = []
  const re = /^\s*(import|export)\s+(type\s+)?[^'";]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm
  for (const m of text.matchAll(re)) {
    if (m[2]) continue
    const spec = m[3] ?? m[4]
    const base = normalize(join(dirname(file), spec))
    const resolved = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((p) => existsSync(join(ROOT, p)))
    out.push(relative(ROOT, join(ROOT, resolved ?? `${base}.ts`)))
  }
  return out
}

const covered = (copied: Set<string>, file: string) =>
  [...copied].some((c) => file === c || file.startsWith(c.endsWith('/') ? c : `${c}/`))

describe('service images copy every wallet file their copied wallet files import', () => {
  for (const image of IMAGES) {
    it(image, () => {
      const copied = copiedFiles(`services/${image}/Dockerfile`)
      const wallet = [...copied].filter((c) => c.startsWith('src/lib/') && c.endsWith('.ts'))
      expect(wallet.length).toBeGreaterThan(0)
      const missing = wallet.flatMap((f) => valueImports(f).filter((dep) => !covered(copied, dep)).map((dep) => `${f} -> ${dep}`))
      expect(missing).toEqual([])
    })
  }

  it('catches the v0.55.3 break (voucherToken importing plainToken for its value)', () => {
    const copied = copiedFiles('services/purchase-issuer/Dockerfile')
    expect(covered(copied, 'src/lib/voucherToken.ts')).toBe(true)
    expect(covered(copied, 'src/lib/plainToken.ts')).toBe(false)
  })
})
