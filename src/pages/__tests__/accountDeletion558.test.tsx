/**
 * @vitest-environment jsdom
 *
 * #558: in-app account deletion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const STALL = 'a'.repeat(64)
const DAY = 86_400_000
const state = vi.hoisted(() => ({ rows: [] as unknown[], published: [] as unknown[] }))

vi.mock('../../lib/wallet', async (orig) => ({
  ...(await orig<typeof import('../../lib/wallet')>()),
  listTransactions: async () => state.rows,
}))
vi.mock('../../lib/transactions', async (orig) => ({
  ...(await orig<typeof import('../../lib/transactions')>()),
  toTransaction: (r: unknown) => r,
}))
vi.mock('../../lib/nap', async (orig) => ({
  ...(await orig<typeof import('../../lib/nap')>()),
  keyStore: { has: async () => true },
  getSigner: () => ({ signEvent: async (e: object) => ({ ...e, created_at: 5, id: 'x', sig: 'y', pubkey: STALL }) }),
}))
vi.mock('../../lib/relay', async (orig) => ({
  ...(await orig<typeof import('../../lib/relay')>()),
  publish: async (e: unknown) => {
    state.published.push(e)
    return { ok: 1 }
  },
}))
vi.mock('../../lib/legacyBridge', () => ({ legacyApi: async () => ({}) }))

const { DeleteAccountPage } = await import('../DeleteAccountPage')
const { SecurityPage } = await import('../SecurityPage')
const { MerchantHomePage } = await import('../MerchantHomePage')
const { emptyMerchant, buildMerchantEvent, mergeMerchantEvent } = await import('../../lib/merchant')
const { deleteAccount, deleteHandle, liabilityBlock, forgetDeletedHandles } = await import('../../lib/accountDeletion')

const merchant = (over = {}) => ({ ...emptyMerchant(STALL), issuanceCurrency: 'EUR', categories: ['food'], ...over })
const issued = (amount: number, expiresAt?: number) => ({ type: 'issued', unit: 'EUR', amount, expiresAt, direction: 'out', at: 0, decimals: 2, id: String(Math.random()) })

afterEach(() => {
  cleanup()
  state.rows = []
  state.published = []
  vi.unstubAllGlobals()
  forgetDeletedHandles()
})

function page(props: Partial<Parameters<typeof DeleteAccountPage>[0]> = {}) {
  const onDeleted = vi.fn()
  const onMerchantSaved = vi.fn()
  render(
    <MemoryRouter>
      <DeleteAccountPage pubkey={STALL} nip05="duran@imani.casa" merchant={null} onDeleted={onDeleted} onMerchantSaved={onMerchantSaved} {...props} />
    </MemoryRouter>,
  )
  return { onDeleted, onMerchantSaved }
}

describe('a merchant with outstanding vouchers is refused', () => {
  it('shows the amount and the last expiry, and offers Close my stall', async () => {
    const last = new Date(2099, 0, 3).getTime()
    state.rows = [issued(20000, Date.now() + DAY), issued(14000, last)]
    const run = vi.fn()
    page({ merchant: merchant(), run })
    const refusal = await screen.findByTestId('liability-refusal')
    expect(refusal.textContent).toMatch(/340\.00/)
    expect(refusal.textContent).toMatch(/(3 Jan 2099|Jan 3, 2099)/)
    expect(refusal.textContent).toMatch(/You can delete your account after that\./)
    expect(screen.getByRole('button', { name: 'Close my stall' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('a merchant with nothing outstanding reaches the confirmation', async () => {
    state.rows = [issued(500, Date.now() - DAY)]
    page({ merchant: merchant() })
    expect(await screen.findByRole('button', { name: 'Delete my account' })).toBeTruthy()
    expect(liabilityBlock(state.rows as never, merchant(), STALL, Date.now())).toBeNull()
  })
})

describe('Close my stall', () => {
  it('publishes salesClosed and withdraws cards on the public record', async () => {
    state.rows = [issued(1000, Date.now() + DAY)]
    const { onMerchantSaved } = page({ merchant: merchant({ acceptsCards: true }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Close my stall' }))
    await waitFor(() => expect(state.published.length).toBe(1))
    const content = JSON.parse((state.published[0] as { content: string }).content)
    expect(content.salesClosed).toBe(true)
    expect(content.acceptsCards).toBeUndefined()
    expect(content.active).toBe(true)
    expect(onMerchantSaved.mock.calls.at(-1)?.[0].salesClosed).toBe(true)
    // A reader of the record sees no card sales.
    const read = mergeMerchantEvent(merchant(), JSON.stringify({ ...content, acceptsCards: true }), 9)
    expect(read.acceptsCards).toBe(false)
    expect(read.salesClosed).toBe(true)
  })

  it('disables Sell and keeps Redeem on the home, with a banner', () => {
    render(
      <MemoryRouter>
        <MerchantHomePage salesClosed />
      </MemoryRouter>,
    )
    expect((screen.getByRole('button', { name: /Sell/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Redeem/ }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('sales-closed').textContent).toMatch(/closed for selling/)
  })

  it('round-trips through the record', () => {
    const e = buildMerchantEvent(merchant({ salesClosed: true }))
    expect(mergeMerchantEvent(merchant(), e.content, 10).salesClosed).toBe(true)
  })
})

describe('customer deletion', () => {
  it('needs the handle typed, then runs the deletion and logs out', async () => {
    const run = vi.fn(async () => ({ status: 'done' as const }))
    const { onDeleted } = page({ run })
    const button = screen.getByRole('button', { name: 'Delete my account' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Type duran to confirm/), { target: { value: 'duran' } })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(run).toHaveBeenCalledWith(STALL, 'duran@imani.casa')
  })

  it('calls the signed DELETE after the logout checks and before the wipe', async () => {
    const order: string[] = []
    const logout = vi.fn(async (_p: string, confirm: (m: string) => boolean, _r: unknown, deps: { proceed?: () => Promise<boolean> }) => {
      order.push('checks')
      confirm('x')
      if (!(await deps.proceed!())) return { status: 'cancelled' as const }
      order.push('push-unsubscribe-and-wipe')
      return { status: 'done' as const }
    })
    const del = vi.fn(async () => {
      order.push('delete')
      return 'deleted' as const
    })
    const out = await deleteAccount(STALL, 'duran@imani.casa', { logout: logout as never, deleteHandle: del })
    expect(out.status).toBe('done')
    expect(order).toEqual(['checks', 'delete', 'push-unsubscribe-and-wipe'])
    expect(del).toHaveBeenCalledWith('duran@imani.casa')
  })

  it('signs a NIP-98 DELETE to the contract URL', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const signer = { signEvent: async (e: object) => ({ ...e, id: 'i', sig: 's', pubkey: STALL }) }
    expect(await deleteHandle('duran@imani.casa', signer as never)).toBe('deleted')
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/nip05?nip05=duran%40imani.casa')
    expect(init.method).toBe('DELETE')
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Nostr /)
  })

  it.each([
    [403, 'not-owner'],
    [404, 'unknown'],
    [500, 'network'],
  ])('maps %s to %s', async (status, want) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })))
    const signer = { signEvent: async (e: object) => ({ ...e, id: 'i', sig: 's', pubkey: STALL }) }
    expect(await deleteHandle('duran@imani.casa', signer as never)).toBe(want)
  })
})

describe('nothing changes when deletion cannot go through', () => {
  it('a blocked logout blocks deletion, with the logout message, and never deletes', async () => {
    const del = vi.fn()
    const blocked = { status: 'blocked' as const, reason: 'in-flight' as const, unconfirmed: [] }
    const out = await deleteAccount(STALL, 'duran@imani.casa', { logout: vi.fn(async () => blocked) as never, deleteHandle: del })
    expect(out).toEqual({ status: 'blocked', logout: blocked })
    expect(del).not.toHaveBeenCalled()

    const { onDeleted } = page({ run: async () => ({ status: 'blocked', logout: blocked }) })
    fireEvent.change(screen.getByLabelText(/Type duran/), { target: { value: 'duran' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
    expect(await screen.findByText(/A payment or a Cashlink is still going through/)).toBeTruthy()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it.each(['not-owner', 'unknown', 'network'] as const)('%s cancels the logout and leaves the account', async (reason) => {
    let wiped = false
    const logout = vi.fn(async (_p: string, _c: unknown, _r: unknown, deps: { proceed?: () => Promise<boolean> }) => {
      if (!(await deps.proceed!())) return { status: 'cancelled' as const }
      wiped = true
      return { status: 'done' as const }
    })
    const out = await deleteAccount(STALL, 'duran@imani.casa', { logout: logout as never, deleteHandle: async () => reason })
    expect(out).toEqual({ status: 'failed', reason })
    expect(wiped).toBe(false)
  })

  it('shows a plain error and a retry on a network failure', async () => {
    const run = vi.fn(async () => ({ status: 'failed' as const, reason: 'network' as const }))
    const { onDeleted } = page({ run })
    fireEvent.change(screen.getByLabelText(/Type duran/), { target: { value: 'duran' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
    expect((await screen.findByTestId('delete-error')).textContent).toMatch(/Nothing was deleted/)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(onDeleted).not.toHaveBeenCalled()
  })
})

describe('placement', () => {
  const security = (terminal: boolean) =>
    render(
      <MemoryRouter>
        <SecurityPage onLogout={() => {}} pubkey={STALL} terminal={terminal} />
      </MemoryRouter>,
    )

  it('is in the Danger zone on Security', () => {
    security(false)
    const zone = screen.getByText('Danger zone').closest('section')!
    expect(zone.querySelector('[data-testid="delete-account-row"]')?.getAttribute('href')).toBe('/settings/security/delete')
  })

  it('is never shown on a terminal', () => {
    security(true)
    expect(screen.queryByTestId('delete-account-row')).toBeNull()
    expect(screen.queryByText('Delete my account')).toBeNull()
  })
})

describe('copy', () => {
  it('uses no em dashes or jargon', async () => {
    page()
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\u2014|NIP-05|nsec|escrow/i)
  })
})

describe('after the handle is deleted', () => {
  it('a logout refused after the DELETE shows Finish, which logs out', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ status: 'deleted-logout-pending', logout: { status: 'blocked', reason: 'other-tab', unconfirmed: [] } })
      .mockResolvedValueOnce({ status: 'done' })
    const { onDeleted } = page({ run })
    fireEvent.change(screen.getByLabelText(/Type duran/), { target: { value: 'duran' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
    expect((await screen.findByTestId('deleted-pending')).textContent).toMatch(/Your account is deleted\. Close other Imani tabs, then tap Finish to log out\./)
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
  })
})

describe('a merchant on a fresh device', () => {
  it('waits for the history restore before answering', async () => {
    state.rows = [issued(1000, Date.now() + DAY)]
    const { unmount } = render(
      <MemoryRouter>
        <DeleteAccountPage pubkey={STALL} nip05="duran@imani.casa" merchant={merchant()} onDeleted={() => {}} onMerchantSaved={() => {}} historyReady={false} />
      </MemoryRouter>,
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByText(/Checking your vouchers/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull()
    unmount()
  })
})
