import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load, available, MissingSnapshotError } from '../fixture'
import { sourceHash, StaleSnapshotError } from '../sources'
import type { Snapshot } from '../snapshot'

let root: string
let snapshots: string

function snapshot(sourceHashValue: string, coupons: number): Snapshot {
  return {
    format: 1,
    recordedAt: '2026-09-01T00:00:00.000Z',
    sourceHash: sourceHashValue,
    coupons,
    databases: [
      {
        name: 'imani-wallet-abc',
        version: 2,
        stores: [
          { name: 'wallet_vouchers', keyPath: 'token_id', autoIncrement: false, records: [{ token_id: 'a' }] },
        ],
      },
    ],
    localStorage: {},
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'perf-fixture-'))
  mkdirSync(join(root, 'watched'), { recursive: true })
  writeFileSync(join(root, 'watched/writer.ts'), 'export const v = 1\n')
  snapshots = join(root, 'snapshots')
  mkdirSync(snapshots, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

/** The real `load` hashes the whole repo; here it hashes the fixture tree. */
const WATCH = ['watched']
const hashNow = () => sourceHash(root, WATCH)

function put(coupons: number, hash: string) {
  writeFileSync(join(snapshots, `coupons-${coupons}.json`), JSON.stringify(snapshot(hash, coupons)))
}

describe('loading a snapshot', () => {
  it('returns one recorded from unchanged sources', () => {
    put(10, hashNow())
    const loaded = load(snapshots, 10, root, WATCH)
    expect(loaded.coupons).toBe(10)
    expect(loaded.databases[0].stores[0].records).toHaveLength(1)
  })

  it('refuses one recorded from sources that have since changed', () => {
    put(10, hashNow())
    writeFileSync(join(root, 'watched/writer.ts'), 'export const v = 2\n')
    expect(() => load(snapshots, 10, root, WATCH)).toThrow(StaleSnapshotError)
  })

  it('says how to record one when none exists', () => {
    expect(() => load(snapshots, 10, root, WATCH)).toThrow(MissingSnapshotError)
    try {
      load(snapshots, 999, root, WATCH)
    } catch (e) {
      expect(String(e)).toContain('perf:record -- --coupons 999')
    }
  })

  it('cannot be bypassed by a caller that forgets to check', () => {
    // The refusal is inside `load`, not beside it, so there is no code path
    // that reads a snapshot without validating it first.
    put(10, 'a-hash-from-different-code')
    expect(() => load(snapshots, 10, root, WATCH)).toThrow(StaleSnapshotError)
  })
})

describe('listing the recorded ladder', () => {
  it('reports rungs in order', () => {
    put(100, hashNow())
    put(10, hashNow())
    put(1000, hashNow())
    expect(available(snapshots)).toEqual([10, 100, 1000])
  })

  it('is empty when nothing has been recorded', () => {
    expect(available(join(root, 'nothing-here'))).toEqual([])
  })

  it('ignores files that are not snapshots', () => {
    put(10, hashNow())
    writeFileSync(join(snapshots, 'README.md'), 'notes\n')
    writeFileSync(join(snapshots, 'coupons-x.json'), '{}\n')
    expect(available(snapshots)).toEqual([10])
  })
})
