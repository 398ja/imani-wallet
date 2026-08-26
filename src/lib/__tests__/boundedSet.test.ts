import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { createBoundedSet, createPersistentBoundedSet } from '../boundedSet'

describe('createBoundedSet', () => {
  it('reports whether an id is new, so callers need no separate has/add dance', () => {
    const set = createBoundedSet(10)
    expect(set.add('a')).toBe(true)
    expect(set.add('a')).toBe(false)
    expect(set.has('a')).toBe(true)
  })

  it('evicts oldest-first at the cap rather than growing forever', () => {
    const set = createBoundedSet(3)
    set.add('1')
    set.add('2')
    set.add('3')
    set.add('4')

    expect(set.size).toBe(3)
    // '1' was the oldest, so it went; the newest three remain.
    expect(set.has('1')).toBe(false)
    expect(set.has('4')).toBe(true)
  })
})

describe('createPersistentBoundedSet', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('survives a reload by reading back what it persisted', () => {
    createPersistentBoundedSet('k', 10).add('n1')
    // A fresh wrapper is what a page reload produces.
    expect(createPersistentBoundedSet('k', 10).has('n1')).toBe(true)
  })

  it('keeps de-duplicating for the session when localStorage is denied', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
      removeItem: () => {},
    })
    const warn = vi.fn()
    const set = createPersistentBoundedSet('k', 10, warn)

    // First sighting is new, every repeat is not — from the in-memory mirror.
    expect(set.add('n1')).toBe(true)
    expect(set.add('n1')).toBe(false)
    expect(set.has('n1')).toBe(true)
    // And it reports the failure rather than swallowing it. Asserted through
    // onWarn, not a `persisted` flag: a flag nothing in production reads is a
    // flag nobody maintains.
    expect(warn).toHaveBeenCalled()
  })

  it('does not throw when storage holds corrupt JSON', () => {
    store.set('k', '{not json')
    const set = createPersistentBoundedSet('k', 10)
    expect(set.has('n1')).toBe(false)
    expect(() => set.add('n1')).not.toThrow()
  })

  it('ignores non-string entries left by an older format', () => {
    store.set('k', JSON.stringify(['ok', 42, null, { a: 1 }]))
    const set = createPersistentBoundedSet('k', 10)
    expect(set.has('ok')).toBe(true)
    expect(set.has('42')).toBe(false)
  })

  it('trims the persisted list to the cap', () => {
    const set = createPersistentBoundedSet('k', 3)
    for (const id of ['1', '2', '3', '4', '5']) set.add(id)

    const persisted: string[] = JSON.parse(store.get('k') ?? '[]')
    expect(persisted).toHaveLength(3)
    expect(persisted).toEqual(['3', '4', '5'])
  })
})
