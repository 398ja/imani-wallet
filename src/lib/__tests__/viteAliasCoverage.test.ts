/**
 * Every workspace package is aliased in every vite build that can reach it.
 *
 * The wallet and its sister sites (subscription, gifting) build `src/lib` through their own
 * vite.config.ts, each with its own list of `@imani/*` aliases. vitest and tsc resolve packages
 * through tsconfig paths, so a list that misses one passes every test and fails only the
 * production build. That happened with `@imani/receipts` (spec 049): the subscription site's
 * image failed on the staging deploy. This test reads the lists and fails here instead.
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../../..')
const PACKAGES = readdirSync(join(ROOT, 'packages')).filter((n) => existsSync(join(ROOT, 'packages', n, 'src/index.ts')))
const CONFIGS = ['vite.config.ts', 'apps/subscription/vite.config.ts', 'apps/gifting/vite.config.ts']

describe('vite aliases cover every workspace package', () => {
  it('finds the packages it checks', () => {
    expect(PACKAGES).toContain('receipts')
  })

  for (const config of CONFIGS) {
    it(`${config} aliases every package`, () => {
      const text = readFileSync(join(ROOT, config), 'utf8')
      const missing = PACKAGES.filter((n) => !text.includes(`'${n}'`))
      expect(missing).toEqual([])
    })
  }
})
