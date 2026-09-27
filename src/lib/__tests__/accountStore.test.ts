/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAccountStore } from '../accountStore'

type Item = { id: string; at: number }
const store = createAccountStore<Item>({
  name: 'test-items',
  limit: 2,
  idOf: (i) => i.id,
  ageOf: (i) => i.at,
  isValid: (v): v is Item => !!v && typeof (v as Item).id === 'string',
})

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

beforeEach(() => localStorage.clear())

describe('createAccountStore', () => {
  it('keeps accounts apart under an imani-wallet: key, so logout sweeps it', () => {
    store.put(A, { id: 'x', at: 1 })
    expect(store.get(A, 'x')).toEqual({ id: 'x', at: 1 })
    expect(store.get(B, 'x')).toBeUndefined()
    expect(localStorage.getItem(`imani-wallet:test-items:${A}`)).not.toBeNull()
  })

  it('replaces by id and keeps only the newest up to the limit', () => {
    store.put(A, { id: 'x', at: 1 })
    store.put(A, { id: 'y', at: 2 })
    store.put(A, { id: 'x', at: 3 })
    store.put(A, { id: 'z', at: 4 })
    expect(store.list(A).map((i) => i.id)).toEqual(['z', 'x'])
  })

  it('filters what it cannot trust and survives corrupt storage', () => {
    localStorage.setItem(`imani-wallet:test-items:${A}`, JSON.stringify([{ id: 'ok', at: 1 }, { nope: true }]))
    expect(store.list(A)).toEqual([{ id: 'ok', at: 1 }])
    localStorage.setItem(`imani-wallet:test-items:${A}`, '{not json')
    expect(store.list(A)).toEqual([])
  })

  it('never throws when the write is refused', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })
    expect(() => store.put(A, { id: 'x', at: 1 })).not.toThrow()
    set.mockRestore()
    warn.mockRestore()
  })
})
