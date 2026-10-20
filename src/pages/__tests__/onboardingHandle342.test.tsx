/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * #342, the exact chain the tester hit, through the REAL `register` and
 * `claimHandle`: only the wire is mocked, and it answers as gateway-core does
 * (`^[a-z0-9_]+$` on `username`, else 400 VALIDATION_001 "Request validation
 * failed" with field errors). Before the fix, "alice " passed `validateHandle`,
 * went out as "alice ", and the form showed "Request validation failed".
 */

const signedFetch = vi.fn()
vi.mock('../../lib/nip98', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/nip98')>()),
  signedFetch: (...args: unknown[]) => signedFetch(...args),
}))
vi.mock('../../lib/config', () => ({ gatewayConfig: async () => ({ nip05Domain: 'example.test' }) }))
vi.mock('../../lib/nap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/nap')>()),
  // An empty key slot, so the #330 guard in `register` lets a fresh device through.
  keyStore: { save: vi.fn(async () => undefined), hasKey: async () => false },
}))
vi.mock('../../lib/onboardingHandoff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/onboardingHandoff')>()),
  stashPendingBackup: vi.fn(),
}))
vi.mock('../../lib/relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/relay')>()),
  publish: vi.fn(async () => ({ ok: 1, total: 1, errors: [] })),
}))
vi.mock('../../components/ParkedClaimBanner', () => ({ ParkedClaimBanner: () => null }))

import { OnboardingPage } from '../OnboardingPage'
import { FinishProfileStep } from '../../components/FinishProfileStep'
import { claimProfile } from '../../lib/profileGate'
import { validateHandle } from '../../lib/validate'

function gateway(_path: string, _method: string, body: { username: string }) {
  if (/^[a-z0-9_]+$/.test(body.username)) return Promise.resolve(new Response('{}', { status: 201 }))
  return Promise.resolve(
    new Response(
      JSON.stringify({
        error: {
          code: 'VALIDATION_001',
          message: 'Request validation failed',
          field_errors: [
            {
              field: 'username',
              message: 'Username must contain only lowercase alphanumeric characters and underscores',
              rejected_value: body.username,
            },
          ],
        },
      }),
      { status: 400 },
    ),
  )
}

const sent = () => signedFetch.mock.calls.map((c) => (c[2] as { username: string }).username)
const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response('{}', { status: 404 }))

beforeEach(() => {
  localStorage.clear()
  signedFetch.mockReset()
  signedFetch.mockImplementation(gateway)
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('onboarding with a padded handle (#342)', () => {
  it('"alice " passes the form check, is claimed as "alice", and no "Request validation failed"', async () => {
    expect(validateHandle('alice ')).toBeUndefined()
    const onUnlock = vi.fn(async () => {})
    render(
      <MemoryRouter initialEntries={[{ pathname: '/onboarding', state: { step: 'account' } }]}>
        <OnboardingPage onUnlock={onUnlock} />
      </MemoryRouter>,
    )
    const input = screen.getByPlaceholderText('your_handle') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Alice ' } })
    expect(input.value).toBe('alice')
    fireEvent.change(screen.getByPlaceholderText('Passphrase'), { target: { value: 'correct horse battery staple' } })
    fireEvent.change(screen.getByPlaceholderText('Confirm passphrase'), { target: { value: 'correct horse battery staple' } })

    // The advisory probe asks about the same string the claim will send.
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/v1/resolve/'))).toBe(true), {
      timeout: 2000,
    })
    const probes = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/v1/resolve/'))
    expect(probes).toEqual([`/api/v1/resolve/${encodeURIComponent('alice@example.test')}`])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    })
    await waitFor(() => expect(onUnlock).toHaveBeenCalled())
    expect(sent()).toEqual(['alice'])
    expect(screen.queryByText('Request validation failed')).toBeNull()
  })
})

describe('Finish your profile with a padded handle (#342)', () => {
  it('"Alice " is claimed as "alice"', async () => {
    const PRIV = '4'.repeat(64)
    let claimed: string | undefined
    render(
      <FinishProfileStep
        onClaim={async (h) => {
          claimed = (await claimProfile(PRIV, h)).nip05
        }}
        onCancel={() => {}}
      />,
    )
    const input = screen.getByLabelText('Handle') as HTMLInputElement
    expect(input.placeholder).toBe('your_handle')
    fireEvent.change(input, { target: { value: 'Alice ' } })
    expect(input.value).toBe('alice')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Finish and log in' }))
    })
    await waitFor(() => expect(claimed).toBe('alice@example.test'))
    expect(sent()).toEqual(['alice'])
  })

  it('a server rejection reads as a plain reason about the handle', async () => {
    signedFetch.mockImplementation(() => gateway('', '', { username: 'x y' }))
    render(<FinishProfileStep onClaim={(h) => claimProfile('4'.repeat(64), h).then(() => undefined)} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'alice' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Finish and log in' }))
    })
    expect(await screen.findByText(/handle can only use lowercase letters, numbers and underscores/i)).toBeTruthy()
    expect(screen.queryByText('Request validation failed')).toBeNull()
  })
})
