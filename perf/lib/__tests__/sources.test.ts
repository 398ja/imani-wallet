import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sourceHash, assertFresh, StaleSnapshotError, WATCHED } from '../sources'

/**
 * A miniature source tree, so these tests exercise the hashing rules rather
 * than the wallet's actual files: a test that changed real sources to prove
 * invalidation would be editing the code it measures.
 */
let root: string

function write(path: string, contents: string) {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents)
}

const WATCH = ['pkg/src', 'app/writer.ts']

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'perf-sources-'))
  write('pkg/src/store.ts', 'export const store = 1\n')
  write('pkg/src/schema.ts', 'export const version = 2\n')
  write('app/writer.ts', 'export function write() {}\n')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('what the hash covers', () => {
  it('is stable when nothing changes', () => {
    expect(sourceHash(root, WATCH)).toBe(sourceHash(root, WATCH))
  })

  it('changes when a watched file changes', () => {
    const before = sourceHash(root, WATCH)
    write('pkg/src/store.ts', 'export const store = 2\n')
    expect(sourceHash(root, WATCH)).not.toBe(before)
  })

  it('changes when a watched file is added', () => {
    const before = sourceHash(root, WATCH)
    write('pkg/src/extra.ts', 'export const extra = true\n')
    expect(sourceHash(root, WATCH)).not.toBe(before)
  })

  it('changes when a watched file moves, since that can change what is written', () => {
    const before = sourceHash(root, WATCH)
    rmSync(join(root, 'pkg/src/store.ts'))
    write('pkg/src/renamed.ts', 'export const store = 1\n')
    expect(sourceHash(root, WATCH)).not.toBe(before)
  })

  it('ignores changes outside the watched paths', () => {
    const before = sourceHash(root, WATCH)
    write('unrelated/thing.ts', 'export const noise = true\n')
    expect(sourceHash(root, WATCH)).toBe(before)
  })

  it('ignores tests, which do not write wallet state', () => {
    // Invalidating on every test edit would train people to re-record
    // reflexively, which defeats the point of noticing at all.
    const before = sourceHash(root, WATCH)
    write('pkg/src/__tests__/store.test.ts', 'it("x", () => {})\n')
    expect(sourceHash(root, WATCH)).toBe(before)
  })

  it('refuses to hash nothing, since a snapshot could then never go stale', () => {
    // The quiet failure this guards: a renamed directory silently empties the
    // watch list, every hash matches, and staleness stops being detectable.
    expect(() => sourceHash(root, ['does/not/exist'])).toThrow(/matched no files/)
  })
})

describe('the drift a schema version would miss', () => {
  it('invalidates when what gets written changes but the schema does not', () => {
    // The whole reason this is a source hash and not a version check. The
    // store's shape is untouched; only the records written into it differ.
    const before = sourceHash(root, WATCH)
    write('app/writer.ts', 'export function write() { return { extra: "field" } }\n')
    expect(sourceHash(root, WATCH)).not.toBe(before)
  })

  it('also invalidates on an ordinary schema change', () => {
    const before = sourceHash(root, WATCH)
    write('pkg/src/schema.ts', 'export const version = 3\n')
    expect(sourceHash(root, WATCH)).not.toBe(before)
  })
})

describe('refusing a stale snapshot', () => {
  it('passes a matching hash', () => {
    expect(() => assertFresh('abc123', 'abc123')).not.toThrow()
  })

  it('throws rather than warns, because a warning in a passing run is unread', () => {
    expect(() => assertFresh('abc123', 'def456')).toThrow(StaleSnapshotError)
  })

  it('says how to fix it, not just that it is broken', () => {
    try {
      assertFresh('abc123', 'def456')
      throw new Error('should have thrown')
    } catch (e) {
      const message = String(e)
      expect(message).toContain('abc123')
      expect(message).toContain('def456')
      expect(message).toContain('perf:record')
    }
  })
})

describe('the watched list', () => {
  it('names the paths that decide what a wallet stores', () => {
    // Guards against the list being quietly emptied or narrowed: this failure
    // is silent, and produces plausible numbers that pass.
    expect(WATCHED).toContain('packages/wallet-storage/src')
    expect(WATCHED).toContain('src/lib/issue.ts')
    expect(WATCHED.length).toBeGreaterThanOrEqual(5)
  })

  it('matches real files in this repository', () => {
    // If a watched path is renamed and this list is not updated, the hash
    // covers less than it claims. `sourceHash` throws only when *nothing*
    // matches, so this checks the real tree rather than a fixture.
    const repoRoot = join(__dirname, '../../..')
    expect(() => sourceHash(repoRoot)).not.toThrow()
  })
})
