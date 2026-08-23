import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Web build only: `isNativePlatform()` false, so these exercise the browser
// path and the fallback. The native path is the plugin's own contract.
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }))
vi.mock('@capacitor/app', () => ({ App: { addListener: () => {} } }))
vi.mock('@capacitor/status-bar', () => ({ StatusBar: {}, Style: {} }))

import { canShare, shareText } from '../native'

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('shareText', () => {
  it('reports no share sheet when the browser has none', () => {
    vi.stubGlobal('navigator', {})
    expect(canShare()).toBe(false)
  })

  it('hands the bare string to the sheet', async () => {
    const share = vi.fn(async () => {})
    vi.stubGlobal('navigator', { share })
    expect(canShare()).toBe(true)
    expect(await shareText('song@398ja.xyz')).toBe(true)
    expect(share).toHaveBeenCalledWith({ text: 'song@398ja.xyz' })
  })

  it('reports failure so the caller can fall back to the clipboard', async () => {
    // A dismissed sheet rejects, and so does a platform with no share target.
    vi.stubGlobal('navigator', { share: async () => { throw new Error('AbortError') } })
    expect(await shareText('song@398ja.xyz')).toBe(false)
    vi.stubGlobal('navigator', {})
    expect(await shareText('song@398ja.xyz')).toBe(false)
  })
})
