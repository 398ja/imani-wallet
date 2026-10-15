/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const native = vi.hoisted(() => ({ value: false }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.value } }))

import { LocationMap } from '../LocationMap'
import { OSM_TILE_URL, mapPoint, safeTileTemplate, tileFor, tileGrid, tileUrlTemplate } from '../../lib/osmTiles'

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
  it('London: only the tiles in view, and the pin pixel in the grid', () => {
    const g = tileGrid(51.5074, -0.1278)
    // px 188 (right half) -> x0 = x; py 100 (top half) -> y0 = y - 1, so the pin
    // is at y 356 and the 176px-high box spans 268..444: the top row is fully
    // clipped and must not be fetched (OSMF policy, review fix rev-263).
    expect(g.tiles).toEqual([
      { src: tile(32744, 21792), left: 0, top: 256 },
      { src: tile(32745, 21792), left: 256, top: 256 },
    ])
    expect(g.pinX).toBeCloseTo(188.088, 2)
    expect(g.pinY).toBeCloseTo(356.518, 2)
  })

  it('Douala needs all four tiles, each in its own quadrant', () => {
    const g = tileGrid(4.0511, 9.7679)
    expect(g.tiles).toEqual([
      { src: tile(34545, 32029), left: 0, top: 0 },
      { src: tile(34546, 32029), left: 256, top: 0 },
      { src: tile(34545, 32030), left: 0, top: 256 },
      { src: tile(34546, 32030), left: 256, top: 256 },
    ])
    expect(g.pinX).toBeCloseTo(305.134, 2)
    expect(g.pinY).toBeCloseTo(231.555, 2)
  })

  it('drops the bottom row when the box ends above it (box is 176px high, not 256)', () => {
    // 51.5N: py 142.55, lower half -> y0 = y, pin at y 142.55, box 54.55..230.55.
    const g = tileGrid(51.5, -0.1278)
    expect(g.pinY).toBeCloseTo(142.55, 2)
    expect(g.tiles.map((t) => t.src)).toEqual([tile(32744, 21794), tile(32745, 21794)])
  })

  it('never asks for a tile row beyond the poles', () => {
    for (const lat of [90, 89.9, 85.06, -85.06, -89.9, -90]) {
      const t = tileFor(lat, 0)
      expect(t.py, String(lat)).toBeCloseTo(lat > 0 ? 0 : 256, 3)
      for (const { src } of tileGrid(lat, 0).tiles) {
        const [, x, y] = src.match(/\/16\/(\d+)\/(\d+)\.png$/)!.map(Number)
        expect(x).toBeLessThan(2 ** 16)
        expect(y, `${lat} -> ${src}`).toBeLessThan(2 ** 16)
      }
    }
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

describe('safeTileTemplate (review fix rev-263)', () => {
  it.each([
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    'https://tiles.example.org/osm/{z}/{x}/{y}@2x.png?key=abc',
  ])('accepts %s', (t) => expect(safeTileTemplate(t)).toBe(t))

  it.each([
    ['empty', ''],
    ['not a string', 42],
    ['http', 'http://tile.example.org/{z}/{x}/{y}.png'],
    ['javascript:', 'javascript:alert(1)//{z}/{x}/{y}'],
    ['data:', 'data:image/png,{z}{x}{y}'],
    ['protocol-relative', '//tile.example.org/{z}/{x}/{y}.png'],
    ['credentials', 'https://u:p@tile.example.org/{z}/{x}/{y}.png'],
    ['missing {y}', 'https://tile.example.org/{z}/{x}.png'],
    ['repeated {x}', 'https://tile.example.org/{z}/{x}/{x}/{y}.png'],
    ['unknown placeholder', 'https://tile.example.org/{s}/{z}/{x}/{y}.png'],
    ['whitespace', 'https://tile.example.org/{z}/{x}/{y}.png '],
  ])('rejects %s', (_n, t) => expect(safeTileTemplate(t)).toBeNull())

  it('an invalid runtime value falls back to the build value, then OSMF', () => {
    ;(globalThis as { GatewayConfig?: unknown }).GatewayConfig = { mapTileUrl: 'javascript:alert(1)//{z}/{x}/{y}' }
    vi.stubEnv('VITE_MAP_TILE_URL', 'https://build.example/{z}/{x}/{y}.png')
    expect(tileUrlTemplate()).toBe('https://build.example/{z}/{x}/{y}.png')
    vi.stubEnv('VITE_MAP_TILE_URL', 'http://build.example/{z}/{x}/{y}.png')
    expect(tileUrlTemplate()).toBe(OSM_TILE_URL)
  })
})

describe('mapPoint (review fix rev-263)', () => {
  it('keeps real coordinates and refuses impossible ones', () => {
    expect(mapPoint('51.5074', '-0.1278')).toEqual({ lat: 51.5074, lng: -0.1278 })
    expect(mapPoint('-90', '180')).toEqual({ lat: -90, lng: 180 })
    for (const [la, ln] of [['Infinity', '0'], ['0', '-Infinity'], ['90.1', '0'], ['0', '180.5'], ['1e9', '0']])
      expect(mapPoint(la, ln), `${la},${ln}`).toBeNull()
  })
})

describe('LocationMap', () => {
  it('renders OSM tiles as images, not an iframe, with the pin', () => {
    const { container } = render(<LocationMap location={AT} />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(srcs(container)).toHaveLength(2)
    expect(srcs(container)).toContain(tile(32744, 21792))
    expect(screen.getByTestId('map-pin')).toBeDefined()
    // The grid is shifted so the pin pixel lands on the box centre, and the
    // pin icon's tip (bottom centre of a 28px icon) sits on that centre.
    const grid = container.querySelector('img')!.parentElement as HTMLElement
    expect(grid.style.left).toMatch(/^calc\(50% - 188\.08\d*px\)$/)
    expect(parseFloat(grid.style.top)).toBeCloseTo(88 - 356.518, 2)
    const pin = screen.getByTestId('map-pin') as unknown as SVGElement
    expect(pin.style.left).toBe('calc(50% - 14px)')
    expect(pin.style.top).toBe('60px')
    const img = container.querySelector('img')!
    expect([img.style.left, img.style.top]).toEqual(['0px', '256px'])
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
    for (const bad of ['', 'somewhere nice', '51.5', '51.5, ', 'a, b', 'Infinity, 0', '200, 500']) {
      const { container } = render(<LocationMap location={bad} />)
      expect(container.innerHTML, bad).toBe('')
      cleanup()
    }
  })
})
