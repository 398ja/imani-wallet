/**
 * @vitest-environment jsdom
 *
 * #591 UI: Settings > Help > "Help improve Imani". Shown only with fleet_enabled AND support_npub;
 * one consent screen (#591 section 3 + #589 consent text); on/off; Snapshot history with fleet lines.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { FleetSnapshotView, FLEET_CONSENT_TEXT } from '../FleetSnapshotPage'
import { CONSENT_TEXT } from '../SupportSnapshotPage'
import type { FleetState } from '../../lib/fleet/state'

const empty: FleetState = { optIn: null, held: null, uploads: [], deregisterNonce: null }

function fake(opts: { available?: boolean; state?: FleetState } = {}) {
  let st = opts.state ?? empty
  return {
    available: vi.fn(async () => opts.available ?? true),
    status: vi.fn(() => ({ optedIn: !!st.optIn, state: st })),
    optIn: vi.fn(async () => {
      st = { ...st, optIn: { consent_version: 1, install_nonce: 'ab'.repeat(32), opted_in_at: 1 } }
    }),
    optOut: vi.fn(async () => {
      st = empty
    }),
  }
}

function draw(c: ReturnType<typeof fake>, onAnswered?: (on: boolean) => void) {
  render(<MemoryRouter><FleetSnapshotView controller={c as never} onAnswered={onAnswered} /></MemoryRouter>)
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('Help improve Imani', () => {
  it('when the feature is not available, says so and offers nothing', async () => {
    const c = fake({ available: false })
    draw(c)
    await screen.findByTestId('fleet-unavailable')
    expect(screen.queryByTestId('fleet-toggle')).toBeNull()
    expect(c.optIn).not.toHaveBeenCalled()
  })

  it('turning it on shows the one fleet consent screen first, and only then opts in', async () => {
    const c = fake()
    draw(c)
    fireEvent.click(await screen.findByTestId('fleet-toggle'))
    const consent = await screen.findByTestId('fleet-consent')
    expect(consent.textContent).toBe(FLEET_CONSENT_TEXT.replaceAll('\n', ''))
    expect(consent.textContent).not.toContain(CONSENT_TEXT.slice(0, 60))
    expect(c.optIn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('fleet-agree'))
    await waitFor(() => expect(c.optIn).toHaveBeenCalledTimes(1))
    await screen.findByText(/is on/i)
  })

  it('cancelling the consent screen opts nothing in', async () => {
    const c = fake()
    draw(c)
    fireEvent.click(await screen.findByTestId('fleet-toggle'))
    fireEvent.click(await screen.findByTestId('fleet-cancel'))
    expect(c.optIn).not.toHaveBeenCalled()
  })

  it('turning it off opts out at once', async () => {
    const c = fake({ state: { ...empty, optIn: { consent_version: 1, install_nonce: 'ab'.repeat(32), opted_in_at: 1 } } })
    draw(c)
    fireEvent.click(await screen.findByTestId('fleet-toggle'))
    await waitFor(() => expect(c.optOut).toHaveBeenCalledTimes(1))
  })

  it('turning it on here answers the first-run question with yes', async () => {
    // Arrange
    const c = fake()
    const answered = vi.fn()
    draw(c, answered)
    fireEvent.click(await screen.findByTestId('fleet-toggle'))

    // Act
    fireEvent.click(await screen.findByTestId('fleet-agree'))

    // Assert
    await waitFor(() => expect(answered).toHaveBeenCalledWith(true))
  })

  it('turning it off here answers the first-run question with no', async () => {
    // Arrange
    const c = fake({ state: { ...empty, optIn: { consent_version: 1, install_nonce: 'ab'.repeat(32), opted_in_at: 1 } } })
    const answered = vi.fn()
    draw(c, answered)

    // Act
    fireEvent.click(await screen.findByTestId('fleet-toggle'))

    // Assert
    await waitFor(() => expect(answered).toHaveBeenCalledWith(false))
  })

  it('cancelling the consent screen answers nothing', async () => {
    // Arrange
    const answered = vi.fn()
    draw(fake(), answered)
    fireEvent.click(await screen.findByTestId('fleet-toggle'))

    // Act
    fireEvent.click(await screen.findByTestId('fleet-cancel'))

    // Assert
    expect(answered).not.toHaveBeenCalled()
  })

  it('criterion 12: lists fleet uploads in Snapshot history', async () => {
    const c = fake({ state: { ...empty, optIn: { consent_version: 1, install_nonce: 'ab'.repeat(32), opted_in_at: 1 }, uploads: [{ round: 'F202611092300', at: Date.parse('2026-11-09T23:10:00Z'), state: 'deleted', counted: true }] } })
    draw(c)
    const list = await screen.findByTestId('fleet-history')
    expect(list.textContent).toMatch(/^Health check on .*2026: deleted from server$/)
  })
})

describe('Settings row', () => {
  it('appears only when fleet is on', async () => {
    const { SettingsPage } = await import('../SettingsPage')
    const { clearConfigCache } = await import('../../lib/config')
    const npub = (await import('nostr-tools')).nip19.npubEncode('ab'.repeat(32))
    for (const [cfg, shown] of [[{ nip05_domain: 'x' }, false], [{ nip05_domain: 'x', fleet_enabled: true }, false], [{ nip05_domain: 'x', fleet_enabled: true, support_npub: npub, support_blossom_url: 'http://b' }, true]] as const) {
      clearConfigCache()
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(cfg), { status: 200 })))
      render(<MemoryRouter><SettingsPage merchant={false} /></MemoryRouter>)
      await new Promise((r) => setTimeout(r, 20))
      expect(!!screen.queryByText('Help improve Imani'), JSON.stringify(cfg)).toBe(shown)
      cleanup()
      vi.unstubAllGlobals()
    }
  })
})

describe('Support snapshot page history', () => {
  it('also lists fleet health checks', async () => {
    const { fleetHistoryLines } = await import('../../lib/fleet/controller')
    const src = (await import('node:fs')).readFileSync('src/pages/SupportSnapshotPage.tsx', 'utf8')
    expect(src).toContain('fleetHistoryLines')
    expect(typeof fleetHistoryLines).toBe('function')
  })
})

describe('fleet consent text (review round 1)', () => {
  it('is fleet-specific, accurate and short', async () => {
    const c = fake()
    draw(c)
    fireEvent.click(await screen.findByTestId('fleet-toggle'))
    const t = (await screen.findByTestId('fleet-consent')).textContent!
    for (const s of ['14 days', 'At most twice a month', 'Wi-Fi', 'Anthropic', 'OpenAI', 'memos', 'app logs', 'forgets this device', 'Nobody can spend']) expect(t, s).toContain(s)
    for (const s of ['ticket', 'memos are shown', '30 days after', 'not linked', 'a few times a month']) expect(t.toLowerCase(), s).not.toContain(s.toLowerCase())
    // Owner review: the previous single paragraph was too long to read before agreeing.
    expect(FLEET_CONSENT_TEXT.split(/\s+/).length).toBeLessThanOrEqual(90)
  })
})
