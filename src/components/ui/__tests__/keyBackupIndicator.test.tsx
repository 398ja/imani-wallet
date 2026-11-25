/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import { KeyBackupIcon } from '../KeyBackupIndicator'
import { Header } from '../Header'
import { IdentityInline } from '../IdentityInline'
import { emptyProfile } from '../../../lib/profile'
import type { KeyBackupState } from '../../../lib/keyBackupState'

const state = vi.hoisted(() => ({ value: 'none' as KeyBackupState }))
vi.mock('../../../lib/keyBackupState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/keyBackupState')>()),
  useKeyBackupState: () => state.value,
}))
vi.mock('../../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/merchant')>()),
  isMerchantPubkey: () => Promise.resolve(false),
}))
vi.mock('../NotificationBell', () => ({ NotificationBell: () => null }))

const PUBKEY = 'c'.repeat(64)
const me = { ...emptyProfile(PUBKEY), name: 'Song', nip05: 'song@imani.example' }

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search}</div>
}

afterEach(cleanup)

describe('KeyBackupIcon', () => {
  it.each([
    ['verified', 'text-green-600', false],
    ['missing', 'text-orange-500', true],
    ['none', 'text-red-600', true],
  ] as const)('%s is %s, blinking %s', (s, colour, blinks) => {
    render(
      <MemoryRouter>
        <KeyBackupIcon state={s} />
      </MemoryRouter>,
    )
    const el = document.querySelector(`[data-state="${s}"]`) as HTMLElement
    expect(el.className).toContain(colour)
    expect(el.classList.contains('key-blink')).toBe(blinks)
    expect(el.getAttribute('aria-label')).toMatch(/key/i)
    expect(el.getAttribute('title')).toBe(el.getAttribute('aria-label'))
  })

  it.each(['missing', 'none'] as const)('%s goes to the backup page with a recommendation', (s) => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={<><KeyBackupIcon state={s} /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('link'))
    expect(screen.getByTestId('where').textContent).toBe(`/settings/backup?recommend=${s}`)
  })

  it('green is not a link', () => {
    render(
      <MemoryRouter>
        <KeyBackupIcon state="verified" />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('who sees the key', () => {
  it('the signed-in user sees it beside their handle', () => {
    state.value = 'none'
    render(
      <MemoryRouter>
        <Header profile={me} onLogout={() => {}} />
      </MemoryRouter>,
    )
    const icon = document.querySelector('[data-state="none"]') as HTMLElement
    expect(icon).not.toBeNull()
    expect(document.body.textContent).toContain('@song')
    // A sibling of the profile link, never nested in it.
    expect(icon.closest('a[href="/profile"]')).toBeNull()
  })

  it('a terminal does not', () => {
    render(
      <MemoryRouter>
        <Header profile={me} terminal onLogout={() => {}} />
      </MemoryRouter>,
    )
    expect(document.querySelector('[data-state]')).toBeNull()
  })

  it('another person never does', () => {
    render(
      <MemoryRouter>
        <IdentityInline pubkey={'d'.repeat(64)} />
      </MemoryRouter>,
    )
    expect(document.querySelector('[data-state]')).toBeNull()
  })
})
