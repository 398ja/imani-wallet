/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * Redeem on a terminal (#160 phase 3, G12, spec 2.5).
 *
 * The request names the stall, so the customer's coupon is gift-wrapped to the stall and a
 * terminal's own wallet receives nothing. Before phase 3 the screen waited on that wallet and
 * could never say Paid. On a terminal it now asks gateway-core whether the request was answered.
 */

// The owner's path, which must not run on a terminal: a terminal has no wallet to reconcile.
const reconciled = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../lib/vreq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/vreq')>()),
  reconcileRequests: async () => {
    reconciled.calls += 1
    return { requests: [], arrivals: [] }
  },
}))
vi.mock('../../lib/wallet', () => ({ onWalletChanged: () => () => {} }))
vi.mock('../../components/ui/RefusedCouponsNote', () => ({ RefusedCouponsNote: () => null }))
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,' } }))

const { RedeemPage } = await import('../RedeemPage')
const { TERMINAL_ROLES, grantFor } = await import('../../lib/terminalRole')
import type { TerminalActor } from '../../lib/actor'
import type { MerchantProfile } from '../../lib/merchant'

const STALL = 'a'.repeat(64)
const DEVICE = 'c'.repeat(64)
const merchant = { pubkey: STALL, active: true, categories: [], issuanceCurrency: 'GBP' } as unknown as MerchantProfile
const till: TerminalActor = {
  kind: 'terminal',
  stallPubkey: STALL,
  role: TERMINAL_ROLES.REDEEM_ONLY,
  terminalPubkey: DEVICE,
  permissions: grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL),
}

beforeEach(() => {
  localStorage.clear()
  reconciled.calls = 0
  // The NUT-18V encoder main.tsx loads; a fixed id keeps the assertions readable.
  ;(window as unknown as { NUT18V: unknown }).NUT18V = {
    generate: () => ({ paymentId: 'pr-0123456789abcdef', requestString: 'vreqA' + 'x'.repeat(60), clickableUri: 'cashu:vreqA' }),
  }
})
afterEach(() => cleanup())

async function ask(fulfilment: (id: string) => Promise<unknown>) {
  render(
    <MemoryRouter>
      <RedeemPage pubkey={DEVICE} merchant={merchant} actor={till} fulfilment={fulfilment as never} />
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '4.50' } })
  fireEvent.click(screen.getByRole('button', { name: 'Show payment code' }))
}

describe('a terminal learns it was paid from gateway-core', () => {
  // The customer pays: gateway-core reports the request answered with the stall's voucher, and
  // the screen says Paid. The owner's wallet reconcile is never run on the terminal.
  it('shows Paid once the request is fulfilled', async () => {
    const asked: string[] = []
    let paid = false
    await ask(async (id) => {
      asked.push(id)
      return paid ? { fulfilled: true, sendId: 's1', issuerId: STALL } : { fulfilled: false }
    })
    expect(await screen.findByText('Waiting for payment')).toBeTruthy()

    paid = true
    expect(await screen.findByText('Paid', {}, { timeout: 5_000 })).toBeTruthy()
    expect(asked[0]).toBe('pr-0123456789abcdef')
    expect(reconciled.calls).toBe(0)
  })

  // A send answered with another stall's voucher did not pay this stall: still waiting.
  it('stays waiting when the answer names another stall', async () => {
    await ask(async () => ({ fulfilled: true, issuerId: 'b'.repeat(64) }))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByText('Waiting for payment')).toBeTruthy()
    expect(screen.queryByText('Paid')).toBeNull()
  })
})
