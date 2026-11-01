/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'

import { LogoutBlockedDialog } from '../LogoutBlocked'
import { useLogout } from '../../lib/useLogout'
import { unconfirmedValue } from '../../lib/logoutBlockedCopy'
import type { LogoutOutcome } from '../../lib/logout'

/**
 * The refusal on screen (owner rule 2026-10-18, review of #326): the count and
 * value of what is not confirmed, a Retry, and NO way to log out anyway.
 */
afterEach(cleanup)

const BLOCKED: Extract<LogoutOutcome, { status: 'blocked' }> = {
  status: 'blocked',
  reason: 'unconfirmed',
  unconfirmed: [
    { token_id: 'a', face_value: 1100, face_unit: 'GBP', face_decimals: 2 },
    { token_id: 'b', face_value: 250, face_unit: 'GBP', face_decimals: 2 },
    { token_id: 'c', status: 'swapped_to_sats', sats_amount: 72, face_value: 900, face_unit: 'GBP', face_decimals: 2 },
  ],
}

describe('LogoutBlockedDialog', () => {
  it('names the count and the value, and offers Retry and Not now only', () => {
    const onRetry = vi.fn()
    render(<LogoutBlockedDialog outcome={BLOCKED} busy={false} onRetry={onRetry} onClose={() => {}} />)

    const body = screen.getByRole('alertdialog').textContent ?? ''
    expect(body).toMatch(/3 vouchers worth £13\.50 \+ 72 sats are not confirmed as backed up/)
    expect(body).toMatch(/Nothing has been erased/)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Try again', 'Not now'])
    expect(body).not.toMatch(/anyway/i)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('a retry in progress cannot be pressed twice', () => {
    render(<LogoutBlockedDialog outcome={BLOCKED} busy onRetry={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: /Checking/ })).toHaveProperty('disabled', true)
  })
})

describe('useLogout', () => {
  it('holds the refusal, then a Retry that confirms logs out', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(BLOCKED)
      .mockResolvedValueOnce({ status: 'done' })
    const onLoggedOut = vi.fn()
    const { result } = renderHook(() => useLogout('ab'.repeat(32), onLoggedOut, run))

    await act(async () => result.current.logout())
    expect(result.current.blocked?.unconfirmed).toHaveLength(3)
    expect(onLoggedOut).not.toHaveBeenCalled()

    await act(async () => result.current.logout())
    expect(onLoggedOut).toHaveBeenCalledOnce()
    expect(result.current.blocked).toBeNull()
  })

  it('a run that throws is shown as a refusal, never as done', async () => {
    const run = vi.fn().mockRejectedValue(new Error('x'))
    const onLoggedOut = vi.fn()
    const { result } = renderHook(() => useLogout('ab'.repeat(32), onLoggedOut, run))
    await act(async () => result.current.logout())
    expect(result.current.blocked?.reason).toBe('store-unreadable')
    expect(onLoggedOut).not.toHaveBeenCalled()
  })
})

describe('unconfirmedValue', () => {
  it('never prints a token or an id', () => {
    expect(unconfirmedValue([{ token_id: 'secret-id', face_value: 100, face_unit: 'EUR', face_decimals: 2 }])).not.toContain('secret-id')
  })
})
