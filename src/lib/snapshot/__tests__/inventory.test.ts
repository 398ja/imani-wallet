/**
 * @vitest-environment node
 *
 * Criterion 2: every localStorage key prefix and IndexedDB store named in src/ and packages/ has an
 * inventory rule. A new key without a rule fails this test, which runs in `npm test` (the CI gate).
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { IDB_STORES, ruleFor } from '../inventory'

const ROOT = join(__dirname, '../../../..')
const SCAN = ['src', 'packages']
const SKIP = /(node_modules|dist|__tests__|\/tests\/|\.test\.|\.spec\.|e2e)/

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (SKIP.test(p)) continue
    const s = statSync(p)
    if (s.isDirectory()) yield* sourceFiles(p)
    else if (/\.(ts|tsx)$/.test(name)) yield p
  }
}

/**
 * Storage key literals: any string literal (quote or template head) that starts with one of the
 * wallet's namespaces and is used as a key. Template literals are cut at the first `${`, which is
 * where a per-pubkey suffix starts, so the rule is matched against the prefix the code writes.
 */
const KEY_LITERAL = /['"`]((?:imani-wallet|imani|imani_dm|imani_)[-_:][A-Za-z0-9_:.-]*)/g

/**
 * Literals that are not storage keys: protocol tags, hash domains, file names, d-tags, metric names,
 * and bare namespace prefixes (`imani-wallet:` on its own is what logout sweeps by, not a key; a key
 * built as `imani-wallet:${name}` cannot be attributed statically, which is why the runtime rule is
 * deny by default and reports it under `unknown_keys`).
 */
const NOT_A_KEY = /^(imani-wallet:?$|imani-wallet-resume$|imani-wallet-snapshots$|imani-snapshot|imani-support-snapshot|imani-deploy|imani-docs|imani-qr|imani-push|imani-woo|imani-merchant$|imani-wallet profile|imani-wallet-account|imani-wallet-backup|imani_nostr_event|imani-(blind|issuer|ledger-key|redeem|transfer|voucher-(key|ledger|locator|ref)|pedersen|terminal-sale|terminal-renew|terminal-credential|terminal-enrolled|terminal-key|terminal:1|terminal-$|cashlink-bundle|cashlink-intent|checkout-code|checkout-refund|gift-(aux|link|out|refund)|shop-enrol|verification$|subscription$|vouchers$|transactions$)|imani_gift_sent|imani_transfer_signature|imani:(held-coupons-changed|receive-trouble-changed|refused-coupons-changed|verification-changed|issued:|afterLogin|pendingPurchase)|imani checkout|imani issued|imani-$|imani-wallet-$|imani-wallet:transfer-$)/

function keyLiterals(): Array<{ key: string; file: string }> {
  const out: Array<{ key: string; file: string }> = []
  for (const dir of SCAN) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(KEY_LITERAL)) {
        const key = m[1]
        if (NOT_A_KEY.test(key)) continue
        out.push({ key, file: relative(ROOT, file) })
      }
    }
  }
  return out
}

const STORE_LITERAL = /createObjectStore\(\s*['"]([a-z_]+)['"]|(?:STORE|STORES\.[A-Z_]+)\s*[:=]\s*['"]([a-z_]+)['"]|^\s*[A-Z_]+:\s*'([a-z_]+)',?$/gm

describe('inventory covers the codebase', () => {
  it('every storage key prefix in src/ and packages/ has a rule', () => {
    const missing = keyLiterals().filter(({ key }) => ruleFor(key) === undefined && ruleFor(key + 'x') === undefined)
    expect(missing, 'add a rule to src/lib/snapshot/inventory.ts for: ' + JSON.stringify(missing, null, 1)).toEqual([])
  })

  it('every IndexedDB store created in packages/ or src/ has a rule', () => {
    const found = new Set<string>()
    for (const dir of SCAN) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8')
        if (!/createObjectStore|STORES\s*=|const STORE\s*=/.test(text)) continue
        for (const m of text.matchAll(STORE_LITERAL)) {
          const name = m[1] ?? m[2] ?? m[3]
          if (name) found.add(name)
        }
      }
    }
    expect(found.size).toBeGreaterThan(3)
    const missing = [...found].filter((s) => !(s in IDB_STORES))
    expect(missing, 'add an IDB_STORES rule for: ' + missing.join(', ')).toEqual([])
  })

  it('every accountStore name (keys built as imani-wallet:<name>:<pubkey>) has a rule', () => {
    const names = new Set<string>()
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8')
      if (!/accountStore/.test(text)) continue
      for (const m of text.matchAll(/\bname:\s*'([a-z][a-z-]+)'/g)) names.add(m[1])
    }
    expect(names.size).toBeGreaterThan(3)
    const missing = [...names].filter((n) => ruleFor(`imani-wallet:${n}:abc`) === undefined)
    expect(missing).toEqual([])
  })

  it('a made-up key with no rule is caught (the rule has teeth)', () => {
    expect(ruleFor('imani-wallet:totally-new-thing:abc')).toBeUndefined()
  })

  it('secrets are always excluded', () => {
    for (const k of ['imani-wallet-key', 'imani-wallet:onboarding-nsec', 'imani:issuer-delegation', 'imani-terminal-attestation', 'imani-terminal-enrolment', 'imani-wallet:fcm-token']) {
      expect(ruleFor(k)?.action, k).toBe('exclude')
    }
  })
})
