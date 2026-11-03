/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { SettingsPage } from '../../pages/SettingsPage'
import { TerminalSettings } from '../../pages/TerminalApp'
import { appVersion, deployVersion } from '../../lib/about'

const roles: Array<[string, () => React.ReactElement]> = [
  ['customer', () => <SettingsPage merchant={false} />],
  ['merchant (stall)', () => <SettingsPage merchant />],
  ['terminal', () => <TerminalSettings />],
]

function about() {
  return within(screen.getByRole('heading', { name: 'About' }).closest('section') as HTMLElement)
}

describe('Settings → About', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://www.imani.casa')
    vi.stubEnv('VITE_DEPLOY_VERSION', 'imani-deploy-v0.3.0')
    vi.stubEnv('VITE_WALLET_VERSION', 'v0.51.0')
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
  })

  it.each(roles)('renders for a %s with versions and legal links', (_role, el) => {
    render(<MemoryRouter>{el()}</MemoryRouter>)
    const a = about()
    expect(a.getByTestId('about-deploy-version').textContent).toBe('imani-deploy-v0.3.0')
    expect(a.getByTestId('about-app-version').textContent).toBe('v0.51.0')
    for (const [name, href] of [
      ['Terms and Conditions', 'https://www.imani.casa/terms.html'],
      ['Privacy policy', 'https://www.imani.casa/privacy.html'],
    ]) {
      const link = a.getByRole('link', { name })
      expect(link.getAttribute('href')).toBe(href)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
    expect(a.getByRole('link', { name: /Contact us/ }).getAttribute('href')).toBe('mailto:hello@imani.casa')
  })

  it('the wallet version is the release tag; without one it is package.json marked "dev", never passed off as a release', () => {
    // package.json is not bumped per release (it said 0.41.0 while v0.50.0 ran on staging).
    vi.stubEnv('VITE_WALLET_VERSION', '')
    render(<MemoryRouter><SettingsPage merchant={false} /></MemoryRouter>)
    expect(about().getByTestId('about-app-version').textContent).toBe(`${__APP_VERSION__} (dev)`)
    expect(appVersion(' v0.51.0 ')).toBe('v0.51.0')
    expect(appVersion(undefined)).toBe(`${__APP_VERSION__} (dev)`)
  })

  it('falls back to "dev" when the build names no deploy version', () => {
    vi.stubEnv('VITE_DEPLOY_VERSION', '')
    render(<MemoryRouter><SettingsPage merchant={false} /></MemoryRouter>)
    expect(about().getByTestId('about-deploy-version').textContent).toBe('dev')
    expect(deployVersion(undefined)).toBe('dev')
    expect(deployVersion('  ')).toBe('dev')
  })

  it('omits the legal links rather than linking nowhere when no website is configured', () => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', '')
    render(<MemoryRouter><SettingsPage merchant={false} /></MemoryRouter>)
    expect(about().queryByRole('link', { name: 'Terms and Conditions' })).toBeNull()
  })
})
