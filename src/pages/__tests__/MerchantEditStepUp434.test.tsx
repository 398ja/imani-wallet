/**
 * @vitest-environment jsdom
 *
 * #434: closing the stall needs the passphrase, and the dialog says why before asking. Cancel and
 * a wrong passphrase leave the stall open and publish nothing. Reopening never asks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const STALL = 'a'.repeat(64)
const calls = vi.hoisted(() => ({ published: [] as unknown[], stepUp: [] as string[] }))

vi.mock('../../lib/reauth', () => ({
  stepUp: async (p: string) => {
    calls.stepUp.push(p)
    if (p !== 'right') throw new Error('That passphrase is not right. Try again.')
  },
}))
vi.mock('../../lib/nap', async (orig) => ({
  ...(await orig<typeof import('../../lib/nap')>()),
  getSigner: () => ({ signEvent: async (e: { content: string }) => ({ ...e, created_at: 1, id: 'x', sig: 'y', pubkey: STALL }) }),
}))
vi.mock('../../lib/relay', async (orig) => ({
  ...(await orig<typeof import('../../lib/relay')>()),
  publish: async (e: unknown) => {
    calls.published.push(e)
    return { ok: 1 }
  },
}))

const { MerchantEditPage } = await import('../MerchantEditPage')
const { emptyMerchant } = await import('../../lib/merchant')

function draw(active: boolean, onSaved = vi.fn()) {
  const merchant = { ...emptyMerchant(STALL), active, categories: ['food'], issuanceCurrency: 'EUR', voucherValidityDays: 30 }
  render(
    <MemoryRouter>
      <MerchantEditPage pubkey={STALL} merchant={merchant} onSaved={onSaved} />
    </MemoryRouter>,
  )
  return onSaved
}

const toggle = () => fireEvent.click(screen.getByRole('switch', { name: /Open for business/ }))
const save = () => fireEvent.click(screen.getByRole('button', { name: /^Save/ }))
const lastActive = () =>
  (JSON.parse((calls.published.at(-1) as { content: string }).content) as { active: boolean }).active

beforeEach(() => {
  calls.published = []
  calls.stepUp = []
  localStorage.clear()
})
afterEach(() => cleanup())

describe('closing the stall (#434)', () => {
  it('asks for the passphrase, explaining why, and publishes nothing until it is given', async () => {
    draw(true)
    toggle()
    save()
    const dialog = await screen.findByRole('dialog')
    expect(screen.getByText("Confirm it's you to close your stall")).toBeTruthy()
    expect(dialog.textContent).toMatch(/Enter your passphrase to complete this/)
    expect(calls.published).toHaveLength(0)
  })

  it('the right passphrase closes it', async () => {
    const onSaved = draw(true)
    toggle()
    save()
    fireEvent.change(await screen.findByPlaceholderText('Passphrase'), { target: { value: 'right' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close stall' }))
    await waitFor(() => expect(calls.published).toHaveLength(1))
    expect(lastActive()).toBe(false)
    expect(onSaved).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a wrong passphrase keeps the dialog, says so, and closes nothing', async () => {
    draw(true)
    toggle()
    save()
    fireEvent.change(await screen.findByPlaceholderText('Passphrase'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close stall' }))
    expect(await screen.findByText(/passphrase is not right/)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(calls.published).toHaveLength(0)
  })

  it('Cancel puts the switch back on and closes nothing', async () => {
    draw(true)
    toggle()
    save()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((screen.getByRole('switch', { name: /Open for business/ }) as HTMLInputElement).checked).toBe(true)
    expect(calls.published).toHaveLength(0)
  })
})

describe('reopening, and other edits (#434)', () => {
  it('reopening saves at once, with no passphrase', async () => {
    draw(false)
    toggle()
    save()
    await waitFor(() => expect(calls.published).toHaveLength(1))
    expect(lastActive()).toBe(true)
    expect(calls.stepUp).toHaveLength(0)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('saving an open stall without closing it never asks', async () => {
    draw(true)
    save()
    await waitFor(() => expect(calls.published).toHaveLength(1))
    expect(calls.stepUp).toHaveLength(0)
  })
})
