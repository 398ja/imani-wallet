/**
 * @vitest-environment jsdom
 *
 * Opening the subscription site from the wallet (#411): the tab the wallet opens is the only window
 * it signs for, only for that site, and never while locked. The browser behaviour (real origins,
 * real `window.opener`, COOP) is proven by e2e/subscription.e2e.ts; this pins the wallet's own logic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

import { createWalletSigner } from '../signer'

const SITE = 'https://subscription.example.test'
const signer = createWalletSigner(bytesToHex(generateSecretKey()))
let locked = false

// The site is this environment's configuration (sisterSites.ts), not a constant in the code.
vi.stubEnv('VITE_SUBSCRIPTION_SITE_URL', SITE)
vi.stubEnv('VITE_GIFTING_SITE_URL', 'https://gifting.example.test')

vi.mock('../nap', () => ({
  getSigner: () => signer,
  getSession: () => ({ getSession: () => ({ pubkey: signer.pubkey }), isLocked: () => locked }),
}))

const { openSisterSite } = await import('../sisterSiteSigner')

interface FakeChild {
  closed: boolean
  posted: Array<{ message: unknown; origin: string }>
  postMessage(message: unknown, origin: string): void
}

function fakeChild(): FakeChild {
  const child: FakeChild = {
    closed: false,
    posted: [],
    postMessage(message, origin) {
      child.posted.push({ message, origin })
    },
  }
  return child
}

describe('openSisterSite', () => {
  let opened: Array<{ url: string; name: string }>
  let child: FakeChild

  beforeEach(() => {
    vi.useFakeTimers()
    locked = false
    opened = []
    child = fakeChild()
    vi.spyOn(window, 'open').mockImplementation(((url: string, name: string) => {
      opened.push({ url, name })
      return child as unknown as Window
    }) as typeof window.open)
  })

  it('opens the site in a named tab, saying which stall it is for', () => {
    expect(openSisterSite(SITE, 'imani-subscription')).toBe(true)
    expect(opened).toHaveLength(1)
    const url = new URL(opened[0].url)
    expect(url.origin).toBe(SITE)
    expect(url.searchParams.get('as')).toBe(signer.pubkey)
    expect(opened[0].name).toBe('imani-subscription')
  })

  it('refuses a site that is not in the signer policy, and opens nothing', () => {
    expect(openSisterSite('https://evil.example/plans', 'x')).toBe(false)
    expect(opened).toHaveLength(0)
  })

  it('says "ready" to the tab it opened, only to the site origin, never with a wildcard', () => {
    openSisterSite(SITE, 'imani-subscription')
    vi.advanceTimersByTime(1000)
    expect(child.posted.length).toBeGreaterThan(0)
    expect(child.posted.every((p) => p.origin === SITE)).toBe(true)
    expect(child.posted.some((p) => (p.message as { type?: string }).type === 'ready')).toBe(true)
  })

  it('stops talking to a tab once it is closed', () => {
    openSisterSite(SITE, 'imani-subscription')
    vi.advanceTimersByTime(1000)
    child.closed = true
    vi.advanceTimersByTime(2000)
    const before = child.posted.length
    vi.advanceTimersByTime(5000)
    expect(child.posted.length).toBe(before)
  })

  it('falls back (returns false) when the browser refuses the tab', () => {
    vi.mocked(window.open).mockReturnValue(null)
    expect(openSisterSite(SITE, 'imani-subscription')).toBe(false)
  })

  it('a locked wallet refuses to connect, so the site shows "unlock your wallet"', async () => {
    locked = true
    openSisterSite(SITE, 'imani-subscription')
    // The site's connect, as the browser would deliver it: from the child window, its origin.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { nap: 'nap-cross-origin-signer/1', type: 'connect', id: 'c1', kinds: [27235], audiences: [SITE] },
        origin: SITE,
        source: child as unknown as Window,
      }),
    )
    await vi.runOnlyPendingTimersAsync()
    const reply = child.posted.map((p) => p.message as { type?: string; id?: string; code?: string }).find((m) => m.id === 'c1')
    expect(reply).toMatchObject({ type: 'error', code: 'DECLINED' })
  })

  it('an unlocked wallet grants the tab a short-lived grant for that site only', async () => {
    openSisterSite(SITE, 'imani-subscription')
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { nap: 'nap-cross-origin-signer/1', type: 'connect', id: 'c2', kinds: [27235], audiences: [SITE] },
        origin: SITE,
        source: child as unknown as Window,
      }),
    )
    await vi.runOnlyPendingTimersAsync()
    const reply = child.posted.map((p) => p.message as { type?: string; id?: string; grant?: { audiences: string[]; pubkey: string } }).find((m) => m.id === 'c2')
    expect(reply).toMatchObject({ type: 'connected', grant: { audiences: [SITE], pubkey: signer.pubkey } })
  })

  it('ignores a connect from any window but the one it opened, even on the site origin', async () => {
    openSisterSite(SITE, 'imani-subscription')
    const other = fakeChild()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { nap: 'nap-cross-origin-signer/1', type: 'connect', id: 'c3', kinds: [27235], audiences: [SITE] },
        origin: SITE,
        source: other as unknown as Window,
      }),
    )
    await vi.runOnlyPendingTimersAsync()
    expect(other.posted).toHaveLength(0)
    expect(child.posted.some((p) => (p.message as { id?: string }).id === 'c3')).toBe(false)
  })
})
