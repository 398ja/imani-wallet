/**
 * @vitest-environment jsdom
 *
 * Review round 1: the app lender refuses another wallet's key; logout stops every fleet loop.
 */
import { describe, expect, it, vi } from 'vitest'

const signerRef: { pubkey: string; withPrivkey: (f: (k: Uint8Array) => unknown) => unknown } = { pubkey: 'aa'.repeat(32), withPrivkey: (f) => f(new Uint8Array(32).fill(7)) }
vi.mock('../../nap', () => ({ getSigner: () => signerRef }))

import { appLender, fleetController, stopAllFleet } from '../app'
import { readFileSync } from 'node:fs'

describe('app wiring', () => {
  it('the lender lends only the wallet it was made for', () => {
    const l = appLender('aa'.repeat(32))
    expect(l.withPrivkey((k) => k.length)).toBe(32)
    signerRef.pubkey = 'bb'.repeat(32)
    const borrow = vi.fn()
    expect(() => l.withPrivkey(borrow)).toThrow()
    expect(borrow).not.toHaveBeenCalled()
    signerRef.pubkey = 'aa'.repeat(32)
  })
  it('stopAllFleet locks and forgets every controller', () => {
    const c = fleetController('aa'.repeat(32), false)
    const lock = vi.spyOn(c, 'lock')
    stopAllFleet()
    expect(lock).toHaveBeenCalled()
    expect(fleetController('aa'.repeat(32), false)).not.toBe(c)
  })
  it('the logout path calls stopAllFleet', () => {
    expect(readFileSync('src/lib/logout.ts', 'utf8')).toMatch(/stopAllFleet\(\)/)
  })
  it('the dev proxy routes /api/v1/support/fleet to support-snapshot, before /api', () => {
    const v = readFileSync('vite.config.ts', 'utf8')
    const i = v.indexOf("'/api/v1/support/fleet': { target: 'http://localhost:28091', changeOrigin: false }")
    expect(i).toBeGreaterThan(0)
    expect(i).toBeLessThan(v.indexOf("'/api':"))
  })
})
