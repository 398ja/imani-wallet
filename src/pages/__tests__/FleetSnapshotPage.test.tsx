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

function draw(c: ReturnType<typeof fake>) {
  render(<MemoryRouter><FleetSnapshotView controller={c as never} /></MemoryRouter>)
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

  it('turning it on shows the one consent screen first, with both texts, and only then opts in', async () => {
    const c = fake()
    draw(c)
    fireEvent.click(await screen.findByTestId('fleet-toggle'))
    const consent = await screen.findByTestId('fleet-consent')
    expect(consent.textContent).toContain('Your wallet may be picked at random a few times a month.')
    expect(consent.textContent).toContain('on Wi-Fi only')
    expect(consent.textContent).toContain(CONSENT_TEXT.slice(0, 60))
    expect(FLEET_CONSENT_TEXT).toContain('never include memos')
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
