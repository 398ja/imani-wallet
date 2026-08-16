import { describe, expect, it, vi } from 'vitest'

/**
 * The only interesting thing in blossom.ts: which endpoint we probe.
 *
 * Primal's `/media` answers 401 without CORS headers, so the browser logs a
 * blocked-request error we cannot catch or suppress — the fix is to not send
 * that request. The skip has to stay scoped to the host, or pointing
 * `blossom_server_url` at a real BUD-05 server would silently keep costing us
 * its EXIF stripping.
 */

let blossomServerUrl: string | null = null

vi.mock('../config', () => ({
  gatewayConfig: async () => ({ nip05Domain: 'imani.local', blossomServerUrl }),
}))
vi.mock('../nap', () => ({ getSigner: () => ({ signEvent: async () => ({}) }) }))

const { blossomServer } = await import('../blossom')

describe('blossomServer — /media probe', () => {
  it('skips the probe on primal.net', async () => {
    blossomServerUrl = 'https://blossom.primal.net'
    expect((await blossomServer())?.preferEndpoint).toBe('upload')
  })

  it('keeps the probe on any other host', async () => {
    blossomServerUrl = 'https://blossom.example.org'
    expect((await blossomServer())?.preferEndpoint).toBe('auto')
  })

  it('does not match a lookalike host', async () => {
    blossomServerUrl = 'https://primal.net.evil.example'
    expect((await blossomServer())?.preferEndpoint).toBe('auto')
  })

  it('returns null when no server is configured', async () => {
    blossomServerUrl = null
    expect(await blossomServer()).toBeNull()
  })
})
