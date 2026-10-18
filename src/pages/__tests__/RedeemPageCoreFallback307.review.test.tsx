/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * #307 review: when the stall's own device cannot register its terms with gateway-core, the till
 * falls back to the wallet path (Paid only once the coupons arrive). That fallback must not be
 * silent: it is logged with the reason, and the till says so in a quiet caption.
 */

vi.mock('../../lib/wallet', () => ({
  listTransactions: async () => [],
  onWalletChanged: () => () => {},
}))
vi.mock('../../components/ui/RefusedCouponsNote', () => ({ RefusedCouponsNote: () => null }))
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,' } }))

const { RedeemPage } = await import('../RedeemPage')
const { registerRequestTerms } = await import('../../lib/terminalTill')
import type { MerchantProfile } from '../../lib/merchant'

const STALL = 'a'.repeat(64)
const merchant = { pubkey: STALL, active: true, categories: [], issuanceCurrency: 'GBP' } as unknown as MerchantProfile
const CAPTION = /Paid will show once the coupons reach this wallet/

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { NUT18V: unknown }).NUT18V = {
    generate: () => ({ paymentId: 'pr-0123456789abcdef', requestString: 'vreqA' + 'x'.repeat(60), clickableUri: 'cashu:vreqA' }),
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function open(register: (t: never) => Promise<boolean>) {
  render(
    <MemoryRouter>
      <RedeemPage
        pubkey={STALL}
        merchant={merchant}
        fulfilment={async () => ({ fulfilled: false })}
        register={register as never}
      />
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '6.50' } })
  fireEvent.click(screen.getByRole('button', { name: 'Show payment code' }))
}

describe('the owner till without gateway-core (#307 review)', () => {
  // Core refused the terms (401: a signature it would not take). The code is still shown, the
  // console says why, and the till says Paid will come from the wallet.
  it('logs the refusal and shows the wallet-only caption', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const register = registerRequestTerms(undefined, (async () => new Response(null, { status: 401 })) as never)
    open(register)
    expect(await screen.findByText('Waiting for payment')).toBeTruthy()
    expect(screen.getByText(CAPTION)).toBeTruthy()
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toMatch(/HTTP 401/)
    expect(logged).toMatch(/#300 gateway-core does not hold this request/)
  })

  // Core holds the terms: no caption, nothing logged by the till.
  it('says nothing when core holds the terms', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    open(async () => true)
    expect(await screen.findByText('Waiting for payment')).toBeTruthy()
    expect(screen.queryByText(CAPTION)).toBeNull()
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).not.toMatch(/\[till\]|#300 gateway-core/)
  })
})
