/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { AboutPage, releaseLabel } from '../AboutPage'
import { SettingsPage } from '../SettingsPage'
import { TerminalSettings } from '../TerminalApp'
import { appVersion, deployVersion } from '../../lib/about'

const roles: Array<[string, () => React.ReactElement]> = [
  ['customer', () => <SettingsPage merchant={false} />],
  ['merchant (stall)', () => <SettingsPage merchant />],
  ['terminal', () => <TerminalSettings />],
]

/** Settings, with the About route mounted, so following the row lands on the real page. */
function settingsThenAbout(settings: React.ReactElement) {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/settings" element={settings} />
        <Route path="/settings/about" element={<AboutPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

function drawAbout() {
  render(
    <MemoryRouter initialEntries={['/settings/about']}>
      <AboutPage />
    </MemoryRouter>,
  )
}

function section(name: string) {
  return within(screen.getByRole('heading', { name }).closest('section') as HTMLElement)
}

beforeEach(() => {
  vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://www.imani.casa')
  vi.stubEnv('VITE_DEPLOY_VERSION', 'imani-deploy-v0.3.0')
  vi.stubEnv('VITE_WALLET_VERSION', 'v0.51.0')
  vi.stubEnv('VITE_TRUSTED_MINT_URLS', 'https://mint.staging.398ja.xyz')
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('Settings → About is its own page', () => {
  it.each(roles)('Settings for a %s shows one About row, not the About details', (_role, el) => {
    settingsThenAbout(el())
    const row = screen.getByRole('link', { name: /About/ })
    expect(row.getAttribute('href')).toBe('/settings/about')
    // The details live on the page, not inline in Settings.
    expect(screen.queryByTestId('about-deploy-version')).toBeNull()
    expect(screen.queryByRole('link', { name: /Terms and Conditions/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /Support/ })).toBeNull()
  })

  it.each(roles)('the About row of a %s opens the About page', (_role, el) => {
    settingsThenAbout(el())
    screen.getByRole('link', { name: /About/ }).click()
    return screen.findByRole('heading', { level: 1, name: 'About imani' }).then(() => {
      expect(screen.getByTestId('about-deploy-version').textContent).toBe('v0.3.0')
    })
  })

  it('the wallet routes /settings/about for every account, with no role predicate', () => {
    // AuthedApp has no test harness (it needs a live session), so the route is read from source:
    // dropping it, or wrapping it in a role gate, fails this test. The terminal's route is
    // exercised for real in TerminalApp.test.tsx.
    const app = readFileSync('src/App.tsx', 'utf8')
    expect(app).toMatch(/<Route path="\/settings\/about" element=\{<AboutPage \/>\} \/>/)
  })
})

describe('the About page', () => {
  it('leads with the name and the wallet version, and goes back to Settings', () => {
    drawAbout()
    expect(screen.getByRole('heading', { level: 1, name: 'About imani' })).toBeTruthy()
    expect(screen.getByTestId('about-app-version').textContent).toBe('v0.51.0')
    // Said once: not repeated in a row below.
    expect(screen.getAllByText('v0.51.0')).toHaveLength(1)
    expect(screen.getByRole('link', { name: /Settings/ }).getAttribute('href')).toBe('/settings')
  })

  it('shows the Imani release without the tag prefix the label already says', () => {
    vi.stubEnv('VITE_DEPLOY_VERSION', 'imani-deploy-v0.3.0-671-g0f97ac0')
    drawAbout()
    expect(section('Release').getByTestId('about-deploy-version').textContent).toBe('v0.3.0-671-g0f97ac0')
    expect(releaseLabel('imani-deploy-v0.3.0')).toBe('v0.3.0')
    // Only the release-tag prefix: a bare sha, "dev" or another tag name is shown as is.
    expect(releaseLabel('0f97ac0')).toBe('0f97ac0')
    expect(releaseLabel('dev')).toBe('dev')
    expect(releaseLabel('demo-2026-10-27-189-gdaa768d')).toBe('demo-2026-10-27-189-gdaa768d')
    expect(releaseLabel('imani-deploy-next')).toBe('imani-deploy-next')
  })

  it('does not show the mint', () => {
    drawAbout()
    expect(screen.queryByTestId('about-mint')).toBeNull()
    expect(screen.queryByText(/mint/i)).toBeNull()
    expect(document.body.textContent).not.toContain('398ja.xyz')
  })

  it('offers Support (not "Contact us") as a mailto to support@imani.casa', () => {
    drawAbout()
    const support = section('Help').getByRole('link', { name: /Support/ })
    expect(support.getAttribute('href')).toBe('mailto:support@imani.casa')
    // The address is shown too, and it is the support one, not the website's general hello@.
    expect(support.textContent).toContain('support@imani.casa')
    expect(document.body.textContent).not.toContain('hello@imani.casa')
    // A mailto opens the mail app; it is not a new tab.
    expect(support.getAttribute('target')).toBeNull()
    expect(screen.queryByText(/Contact us/i)).toBeNull()
  })

  it('links the legal pages on the website in a new tab, and says so to a screen reader', () => {
    drawAbout()
    const legal = section('Legal')
    for (const [name, href] of [
      ['Terms and Conditions', 'https://www.imani.casa/terms.html'],
      ['Privacy policy', 'https://www.imani.casa/privacy.html'],
      ['Cookie policy', 'https://www.imani.casa/cookies.html'],
    ]) {
      const link = legal.getByRole('link', { name: new RegExp(`^${name} \\(opens in a new tab\\)$`) })
      expect(link.getAttribute('href')).toBe(href)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('drops the Legal group rather than linking nowhere when no website is configured', () => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', '')
    drawAbout()
    expect(screen.queryByRole('heading', { name: 'Legal' })).toBeNull()
    expect(screen.queryByRole('link', { name: /Terms and Conditions/ })).toBeNull()
    // Support does not depend on the website.
    expect(screen.getByRole('link', { name: /Support/ })).toBeTruthy()
  })

  it('the wallet version is the release tag; without one it is package.json marked "dev", never passed off as a release', () => {
    // package.json is not bumped per release (it said 0.41.0 while v0.50.0 ran on staging).
    vi.stubEnv('VITE_WALLET_VERSION', '')
    drawAbout()
    expect(screen.getByTestId('about-app-version').textContent).toBe(`${__APP_VERSION__} (dev)`)
    expect(appVersion(' v0.51.0 ')).toBe('v0.51.0')
    expect(appVersion(undefined)).toBe(`${__APP_VERSION__} (dev)`)
  })

  it('falls back to "dev" when the build names no deploy version', () => {
    vi.stubEnv('VITE_DEPLOY_VERSION', '')
    drawAbout()
    expect(screen.getByTestId('about-deploy-version').textContent).toBe('dev')
    expect(deployVersion(undefined)).toBe('dev')
    expect(deployVersion('  ')).toBe('dev')
  })

  it('wraps a long release string rather than cutting it off: it is what gets sent to Support', () => {
    const long = 'v0.3.0-671-g0f97ac0-dirty-with-a-very-long-suffix'
    vi.stubEnv('VITE_DEPLOY_VERSION', long)
    drawAbout()
    const v = screen.getByTestId('about-deploy-version')
    expect(v.textContent).toBe(long)
    expect(v.className).not.toMatch(/\btruncate\b/)
    expect(v.className).toMatch(/\bbreak-all\b/)
  })
})
