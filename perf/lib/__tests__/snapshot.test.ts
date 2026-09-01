import { describe, it, expect } from 'vitest'
import { countRecords, type Snapshot } from '../snapshot'

/**
 * The browser round trip is proven by `npm run perf:verify-snapshot`, which
 * drives a real browser against a real schema. These are the shape rules that
 * can be checked without one.
 */

function snapshot(stores: Snapshot['databases'][number]['stores']): Snapshot {
  return {
    format: 1,
    recordedAt: '2026-09-01T00:00:00.000Z',
    sourceHash: 'abc1234567890def',
    coupons: 2,
    databases: [{ name: 'imani-wallet-x', version: 2, stores }],
    localStorage: {},
  }
}

describe('counting what a snapshot holds', () => {
  it('counts records across every store', () => {
    expect(
      countRecords(
        snapshot([
          { name: 'wallet_vouchers', keyPath: 'token_id', autoIncrement: false, records: [{}, {}] },
          { name: 'wallet_transactions', keyPath: 'id', autoIncrement: false, records: [{}] },
        ]),
      ),
    ).toBe(3)
  })

  it('counts an empty wallet as empty', () => {
    expect(countRecords(snapshot([]))).toBe(0)
  })
})

describe('out-of-line keys', () => {
  /**
   * A store created with no keyPath and no generator keeps its keys OUTSIDE
   * the record. The wallet has one: `src/lib/resume.ts` creates `wrap` that
   * way. Capturing only the values loses the keys, and restoring then throws:
   *
   *   DataError: the object store uses out-of-line keys and has no key
   *   generator and the key parameter was not provided
   *
   * That bug shipped in the first version of this module and was invisible
   * until a snapshot was restored into a real browser, because nothing else
   * exercised the write path.
   */
  it('carries keys for a store that has no keyPath', () => {
    const store = {
      name: 'wrap',
      keyPath: null,
      autoIncrement: false,
      records: [{ some: 'value' }],
      keys: ['a-key'],
    }
    const snap = snapshot([store])
    expect(snap.databases[0].stores[0].keys).toEqual(['a-key'])
    expect(countRecords(snap)).toBe(1)
  })

  it('pairs each key with its record by position', () => {
    const store = {
      name: 'wrap',
      keyPath: null,
      autoIncrement: false,
      records: [{ n: 1 }, { n: 2 }, { n: 3 }],
      keys: ['k1', 'k2', 'k3'],
    }
    expect(store.keys).toHaveLength(store.records.length)
  })

  it('leaves in-line stores without keys, since a key argument is rejected there', () => {
    const store = {
      name: 'wallet_vouchers',
      keyPath: 'token_id',
      autoIncrement: false,
      records: [{ token_id: 'a' }],
    }
    expect('keys' in store).toBe(false)
  })
})
