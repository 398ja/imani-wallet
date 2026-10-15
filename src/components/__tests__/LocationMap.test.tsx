/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const native = vi.hoisted(() => ({ value: false }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.value } }))

import { LocationMap } from '../LocationMap'
import { OSM_TILE_URL, tileFor, tileGrid } from '../../lib/osmTiles'

/**
 * The stall location as a static OpenStreetMap map (#263): tiles as <img>, no
 * iframe, no Google. jsdom never fetches <img> sources, so nothing here touches
 * the network. Reference values computed independently from the Web Mercator
 * formulas at zoom 16.
 */

const AT = '51.507400, -0.127800'
const tile = (x: number, y: number) => `https://tile.openstreetmap.org/16/${x}/${y}.png`
const srcs = (c: HTMLElement) => [...c.querySelectorAll('img')].map((i) => i.getAttribute('src'))

beforeEach(() => {
  native.value = false
  delete (globalThis as { GatewayConfig?: unknown }).GatewayConfig
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('tileFor (Web Mercator, z16)', () => {
  it.each([
    ['London', 51.5074, -0.1278, 32744, 21792, 188.088, 100.518],
    ['Douala', 4.0511, 9.7679, 34546, 32029, 49.134, 231.555],
    ['tile corner at 0,0', 0, 0, 32768, 32768, 0, 0],
    ['east of the antimeridian', 0.001, 179.999, 65535, 32767, 209.397, 209.397],
    ['west of the antimeridian', -0.001, -179.999, 0, 32768, 46.603, 46.603],
    ['high latitude (Hammerfest)', 70.6634, 23.6821, 37079, 14308, 49.853, 29.126],
  ])('%s', (_n, lat, lng, x, y, px, py) => {
    const t = tileFor(lat, lng)
    expect([t.x, t.y]).toEqual([x, y])
    expect(t.px).toBeCloseTo(px, 2)
    expect(t.py).toBeCloseTo(py, 2)
  })

  it('wraps longitude 180 onto tile 0 and clamps the poles', () => {
    expect(tileFor(0, 180).x).toBe(0)
    expect(tileFor(89.9, 0).y).toBe(0)
    expect(tileFor(-89.9, 0).y).toBe(2 ** 16 - 1)
  })
})

describe('tileGrid', () => {
  it('London: the 2x2 tiles around the pin and the pin pixel in the grid', () => {
    const g = tileGrid(51.5074, -0.1278)
    // px 188 (right half) -> x0 = x; py 100 (top half) -> y0 = y - 1
    expect(g.tiles.map((t) => t.src)).toEqual([
      tile(32744, 21791), tile(32745, 21791), tile(32744, 21792), tile(32745, 21792),
    ])
    expect(g.pinX).toBeCloseTo(188.088, 2)
    expect(g.pinY).toBeCloseTo(356.518, 2)
  })

  it('near a tile edge (0,0) takes the tiles on both sides', () => {
    const g = tileGrid(0, 0)
    expect(g.tiles.map((t) => t.src)).toEqual([
      tile(32767, 32767), tile(32768, 32767), tile(32767, 32768), tile(32768, 32768),
    ])
    expect([g.pinX, g.pinY]).toEqual([256, 256])
  })

  it('across the antimeridian wraps x to 0 instead of 65536', () => {
    const g = tileGrid(0.001, 179.999)
    expect(g.tiles.map((t) => t.src)).toContain(tile(0, 32767))
    expect(g.tiles.map((t) => t.src)).not.toContain(tile(65536, 32767))
  })

  it('honours a configured template', () => {
    const g = tileGrid(0, 0, 'https://tiles.example.org/osm/{z}/{x}/{y}.png')
    expect(g.tiles[0].src).toBe('https://tiles.example.org/osm/16/32767/32767.png')
  })
})

describe('LocationMap', () => {
  it('renders OSM tiles as images, not an iframe, with the pin', () => {
    const { container } = render(<LocationMap location={AT} />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(srcs(container)).toHaveLength(4)
    expect(srcs(container)).toContain(tile(32744, 21792))
    expect(screen.getByTestId('map-pin')).toBeDefined()
    for (const img of container.querySelectorAll('img')) {
      expect(img.getAttribute('alt')).toBe('')
      expect(img.getAttribute('loading')).toBe('lazy')
      // OSMF's tile policy requires the Referer.
      expect(img.getAttribute('referrerpolicy')).toBeNull()
    }
    expect(container.innerHTML).not.toMatch(/google/i)
  })

  it('shows the visible OSM attribution linking to /copyright', () => {
    render(<LocationMap location={AT} />)
    const a = screen.getByText('© OpenStreetMap contributors') as HTMLAnchorElement
    expect(a.getAttribute('href')).toBe('https://www.openstreetmap.org/copyright')
  })

  it('names the merchant in the heading and the map', () => {
    render(<LocationMap location={AT} label="Marlow Books" />)
    expect(screen.getByText('Find Marlow Books')).toBeDefined()
    expect(screen.getByLabelText('Map showing Marlow Books')).toBeDefined()
  })

  it('opens openstreetmap.org in a new tab on the web', () => {
    render(<LocationMap location={AT} />)
    const a = screen.getByText('Open in Maps').closest('a')!
    expect(a.getAttribute('href')).toBe(
      'https://www.openstreetmap.org/?mlat=51.507400&mlon=-0.127800#map=17/51.507400/-0.127800',
    )
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('opens a geo: URI in the Android app', () => {
    native.value = true
    render(<LocationMap location={AT} />)
    const a = screen.getByText('Open in Maps').closest('a')!
    expect(a.getAttribute('href')).toBe('geo:51.507400,-0.127800?q=51.507400,-0.127800')
  })

  it('uses the runtime gateway tile template, then VITE_MAP_TILE_URL, then OSMF', () => {
    vi.stubEnv('VITE_MAP_TILE_URL', 'https://build.example/{z}/{x}/{y}.png')
    let r = render(<LocationMap location="0, 0" />)
    expect(srcs(r.container)[0]).toBe('https://build.example/16/32767/32767.png')
    cleanup()
    ;(globalThis as { GatewayConfig?: unknown }).GatewayConfig = { mapTileUrl: 'https://rt.example/{z}/{x}/{y}.png' }
    r = render(<LocationMap location="0, 0" />)
    expect(srcs(r.container)[0]).toBe('https://rt.example/16/32767/32767.png')
    cleanup()
    vi.unstubAllEnvs()
    delete (globalThis as { GatewayConfig?: unknown }).GatewayConfig
    r = render(<LocationMap location="0, 0" />)
    expect(srcs(r.container)[0]).toBe(OSM_TILE_URL.replace('{z}/{x}/{y}', '16/32767/32767'))
  })

  it('renders NOTHING when the stall has no location', () => {
    const { container } = render(<LocationMap location={undefined} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing for a location that will not parse', () => {
    for (const bad of ['', 'somewhere nice', '51.5', '51.5, ', 'a, b']) {
      const { container } = render(<LocationMap location={bad} />)
      expect(container.innerHTML, bad).toBe('')
      cleanup()
    }
  })
})
