import { Capacitor } from '@capacitor/core'

/**
 * Static OpenStreetMap map maths for `LocationMap` (#263): Web Mercator tiles,
 * the configured tile URL and the "Open in Maps" target.
 */

/** OSMF's tile server, the default when nothing is configured (#263). */
export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
export const MAP_ZOOM = 16
export const TILE = 256
/** Box size. 2x2 tiles chosen around the pin always cover 128px either side. */
export const BOX_W = 256
export const BOX_H = 176
const MAX_LAT = 85.0511287798

/**
 * The tile URL template: runtime gateway config (`map_tile_url` on
 * /api/v1/config) first, then the build-time `VITE_MAP_TILE_URL`, then OSMF.
 * Configurable because OSMF tiles are best effort and may be withdrawn, and
 * switching provider should not need a release.
 */
export function tileUrlTemplate(): string {
  const runtime = (globalThis as { GatewayConfig?: { mapTileUrl?: string } }).GatewayConfig?.mapTileUrl
  return runtime || import.meta.env.VITE_MAP_TILE_URL || OSM_TILE_URL
}

/**
 * Web Mercator: the tile holding (lat, lng) at `zoom` and the pin's pixel
 * offset inside it. x wraps across the antimeridian, latitude is clamped to
 * the projection's limit.
 */
export function tileFor(lat: number, lng: number, zoom = MAP_ZOOM) {
  const n = 2 ** zoom
  const la = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180
  const wx = ((((lng + 180) / 360) % 1) + 1) % 1 * n * TILE
  const wy = ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n * TILE
  const x = Math.min(n - 1, Math.floor(wx / TILE))
  const y = Math.max(0, Math.min(n - 1, Math.floor(wy / TILE)))
  return { zoom, n, x, y, px: wx - x * TILE, py: wy - y * TILE }
}

/** The 2x2 tiles around the pin, and where the pin sits in that grid. */
export function tileGrid(lat: number, lng: number, template = OSM_TILE_URL, zoom = MAP_ZOOM) {
  const t = tileFor(lat, lng, zoom)
  const x0 = t.px < TILE / 2 ? t.x - 1 : t.x
  const y0 = t.py < TILE / 2 ? t.y - 1 : t.y
  const tiles: { src: string; left: number; top: number }[] = []
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < 2; dx++) {
      const ty = y0 + dy
      if (ty < 0 || ty >= t.n) continue // beyond the poles: nothing to draw
      const tx = (((x0 + dx) % t.n) + t.n) % t.n
      const src = template.replace('{z}', String(zoom)).replace('{x}', String(tx)).replace('{y}', String(ty))
      tiles.push({ src, left: dx * TILE, top: dy * TILE })
    }
  return { tiles, pinX: (t.x - x0) * TILE + t.px, pinY: (t.y - y0) * TILE + t.py }
}

/** Where tapping the map goes: the Android maps chooser, or openstreetmap.org. */
export function openInMapsHref(lat: string, lng: string): string {
  if (Capacitor.isNativePlatform()) return `geo:${lat},${lng}?q=${lat},${lng}`
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`
}
