import { describe, expect, it } from 'vitest'
import { shouldResell } from './resell.mts'

describe('shouldResell (#566)', () => {
  it('does not resell when the balance rose by the sale', () => {
    expect(shouldResell('EUR 19.00', 'EUR 24.00', '5.00')).toBe(false)
  })
  it('does not resell when the balance rose by more (another receive landed too)', () => {
    expect(shouldResell('EUR 19.00', 'EUR 26.00', '5.00')).toBe(false)
  })
  it('resells when the balance did not move', () => {
    expect(shouldResell('EUR 19.00', 'EUR 19.00', '5.00')).toBe(true)
  })
  it('resells when the balance rose by less than the sale', () => {
    expect(shouldResell('EUR 19.00', 'EUR 21.00', '5.00')).toBe(true)
  })
  it('handles a zero start', () => {
    expect(shouldResell('EUR 0.00', 'EUR 5.00', '5.00')).toBe(false)
  })
  it('does not resell on an unreadable balance', () => {
    expect(shouldResell('?', 'EUR 5.00', '5.00')).toBe(false)
    expect(shouldResell('EUR 0.00', '?', '5.00')).toBe(false)
  })
})
