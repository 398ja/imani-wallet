import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clearPendingBackup, peekPendingBackup, stashPendingBackup } from '../onboardingHandoff'

const A = 'aaaa000000000000000000000000000000000000000000000000000000000000'
const B = 'bbbb000000000000000000000000000000000000000000000000000000000000'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})

describe('pending backup key', () => {
  it('returns the key to the account it belongs to', () => {
    stashPendingBackup(A, 'nsec1aaa')
    expect(peekPendingBackup(A)).toBe('nsec1aaa')
  })

  it('never returns one account’s key to another', () => {
    // Register A, leave the backup screen without ticking the box, refresh (the
    // session is in memory, so the app drops to /login), then import key B.
    // Unscoped, B's welcome screen showed A's nsec under B's handle — the user
    // writes down the wrong key while B's enrolment has already overwritten A.
    stashPendingBackup(A, 'nsec1aaa')
    expect(peekPendingBackup(B)).toBeNull()
  })

  it('reads without consuming, so a refresh mid-backup still shows the key', () => {
    // Also why this is not a read-and-remove: it is called from a useState
    // initialiser, and StrictMode invokes those twice in development.
    stashPendingBackup(A, 'nsec1aaa')
    expect(peekPendingBackup(A)).toBe('nsec1aaa')
    expect(peekPendingBackup(A)).toBe('nsec1aaa')
  })

  it('is gone once the user confirms they saved it', () => {
    stashPendingBackup(A, 'nsec1aaa')
    clearPendingBackup()
    expect(peekPendingBackup(A)).toBeNull()
  })

  it('survives a corrupt slot without throwing', () => {
    store.set('imani-wallet:onboarding-nsec', '{not json')
    expect(peekPendingBackup(A)).toBeNull()
  })

  it('returns nothing when there is nothing stashed', () => {
    expect(peekPendingBackup(A)).toBeNull()
  })
})
