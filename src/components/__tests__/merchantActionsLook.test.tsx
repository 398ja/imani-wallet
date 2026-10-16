/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MerchantActions } from '../MerchantActions'

/**
 * A disabled action must LOOK disabled, and both disabled actions must carry the same weight.
 * A disabled Buy used to keep the solid primary fill, which read as pressable and heavier than
 * the disabled Pay beside it (review of #281).
 */

const STALL = 'b'.repeat(64)

afterEach(cleanup)

function buttons(acceptsCards: boolean) {
  render(
    <MemoryRouter>
      <MerchantActions pubkey={STALL} acceptsCards={acceptsCards} />
    </MemoryRouter>,
  )
  return {
    buy: screen.getByRole('button', { name: 'Buy a voucher with card' }),
    pay: screen.getByRole('button', { name: 'Pay with your vouchers' }),
  }
}

describe('Buy and Pay styling', () => {
  it('gives a disabled Buy the same quiet look as a disabled Pay', () => {
    const { buy, pay } = buttons(false)
    expect((buy as HTMLButtonElement).disabled).toBe(true)
    expect((pay as HTMLButtonElement).disabled).toBe(true)
    expect(buy.className).not.toContain('bg-mono-900')
    expect(buy.className).toBe(pay.className)
  })

  it('keeps an enabled Buy as the primary action', () => {
    const { buy } = buttons(true)
    expect((buy as HTMLButtonElement).disabled).toBe(false)
    expect(buy.className).toContain('bg-mono-900')
  })
})
