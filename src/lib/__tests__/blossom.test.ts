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

const { blossomServer, compress } = await import('../blossom')

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

/**
 * Compression is an optimisation, so the only thing that must never happen is
 * an upload it makes worse. Each case here is one way it could: a flattened
 * animation, a bigger file than we started with, or a decode failure taken as
 * an upload failure. The happy path needs a real image decoder, which jsdom has
 * no business pretending to be.
 */
describe('compress — never makes an upload worse', () => {
  const gif = new File([new Uint8Array(400)], 'a.gif', { type: 'image/gif' })
  const png = new File([new Uint8Array(400)], 'a.png', { type: 'image/png' })

  it('leaves a GIF alone rather than flattening its animation', async () => {
    expect(await compress(gif, 'avatar')).toBe(gif)
  })

  it('falls back to the original when the image will not decode', async () => {
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('undecodable')
    })
    expect(await compress(png, 'avatar')).toBe(png)
    vi.unstubAllGlobals()
  })

  it('keeps the original when re-encoding did not shrink it', async () => {
    // No jsdom in this suite, so the canvas is stubbed outright rather than
    // pulling in a DOM to hold one method.
    vi.stubGlobal('createImageBitmap', async () => ({
      width: 64,
      height: 64,
      close: () => {},
    }))
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (cb: (b: Blob) => void) =>
          cb(new Blob([new Uint8Array(4000)], { type: 'image/webp' })),
      }),
    })

    expect(await compress(png, 'avatar')).toBe(png)

    vi.unstubAllGlobals()
  })
})
