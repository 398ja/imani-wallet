/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * Claim links, phase 0 (docs/spec-claim-links.md, sections 1.6, 2.5 and 8): opening a claim link
 * with NO session must route by DEVICE, not always to registration.
 *
 * - A device that holds a key (a returning customer whose session ended) goes to /login, to
 *   unlock: sending them to /onboarding offered Register to someone who already has an account.
 * - A device with no key goes to /onboarding, as before.
 * - A terminal goes to its till, never to /login (a terminal key must not open a customer session).
 *
 * Either way the claim is parked and the fragment is scrubbed from the address bar BEFORE the
 * first await (the key-store check is async), and nothing is redeemed.
 */

const hasStoredKey = vi.fn<() => Promise<boolean>>()
const isTerminalDevice = vi.fn<() => boolean>()
const redeemClaimRef = vi.fn()

vi.mock('../../lib/nap', () => ({ hasStoredKey: () => hasStoredKey() }))
vi.mock('../../lib/terminalEnrol', () => ({ isTerminalDevice: () => isTerminalDevice() }))
vi.mock('../../lib/cashback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashback')>()),
  redeemClaimRef: (...args: unknown[]) => redeemClaimRef(...args),
}))

import { ClaimLandingPage } from '../ClaimLandingPage'
import { peekPendingClaim } from '../../lib/pendingClaim'

const REF = 'abcd1234efgh5678'
const KEY = 'K'.repeat(43)

function openLink() {
  window.history.replaceState(null, '', `/c/${REF}#k=${KEY}`)
  return render(
    <MemoryRouter initialEntries={[`/c/${REF}`]}>
      <Routes>
        <Route path="/c/:ref" element={<ClaimLandingPage authed={false} />} />
        <Route path="/login" element={<p>LOGIN SCREEN</p>} />
        <Route path="/onboarding" element={<p>ONBOARDING SCREEN</p>} />
        <Route path="/terminal/unlock" element={<p>TILL SCREEN</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('a claim link opened with no session (phase 0)', () => {
  beforeEach(() => {
    localStorage.clear()
    hasStoredKey.mockReset()
    isTerminalDevice.mockReset().mockReturnValue(false)
    redeemClaimRef.mockReset()
  })
  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
  })

  it('sends a device that holds a key to Login, not to registration', async () => {
    hasStoredKey.mockResolvedValue(true)
    openLink()

    expect(await screen.findByText('LOGIN SCREEN')).toBeTruthy()
    expect(screen.queryByText('ONBOARDING SCREEN')).toBeNull()
    expect(peekPendingClaim()).toMatchObject({ ref: REF, key: KEY })
    expect(redeemClaimRef).not.toHaveBeenCalled()
  })

  it('sends a device with no key to onboarding', async () => {
    hasStoredKey.mockResolvedValue(false)
    openLink()

    expect(await screen.findByText('ONBOARDING SCREEN')).toBeTruthy()
    expect(peekPendingClaim()).toMatchObject({ ref: REF, key: KEY })
    expect(redeemClaimRef).not.toHaveBeenCalled()
  })

  it('falls back to onboarding when the key store cannot be read', async () => {
    hasStoredKey.mockRejectedValue(new Error('indexeddb blocked'))
    openLink()

    expect(await screen.findByText('ONBOARDING SCREEN')).toBeTruthy()
  })

  it('sends a terminal to its till and parks nothing for it', async () => {
    isTerminalDevice.mockReturnValue(true)
    hasStoredKey.mockResolvedValue(true)
    openLink()

    expect(await screen.findByText('TILL SCREEN')).toBeTruthy()
    expect(screen.queryByText('LOGIN SCREEN')).toBeNull()
    expect(peekPendingClaim()).toBeNull()
  })

  it('parks the claim and scrubs the fragment before the first await', () => {
    // Never resolves: anything observed here happened synchronously, before the key-store read.
    hasStoredKey.mockReturnValue(new Promise(() => {}))
    openLink()

    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain(KEY)
    expect(peekPendingClaim()).toMatchObject({ ref: REF, key: KEY })
  })
})
