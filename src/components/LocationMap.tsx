import { Capacitor } from '@capacitor/core'
import { MapPin } from 'lucide-react'

import { parseLatLng } from '../lib/coords'
import { BOX_H, BOX_W, TILE, mapPoint, openInMapsHref, tileGrid, tileUrlTemplate } from '../lib/osmTiles'

/**
 * Where a stall is, read-only, as a pin on a static OpenStreetMap map (#263).
 *
 * Shared by the read-only stall views and `LocationField`'s preview, so the two
 * cannot drift.
 *
 * Static on purpose: 2x2 `<img>` tiles from the configured tile server (see
 * `tileUrlTemplate`), the pin drawn at the exact pixel, no iframe, no library
 * and no third-party script. It replaced a third-party map iframe that could set
 * cookies without consent (PECR). Tile requests set no cookies; they do
 * send the IP address and a Referer to the tile server, which the privacy
 * policy discloses. OSMF's tile policy requires that Referer, so the tiles
 * must NOT carry `referrerpolicy="no-referrer"`, and requires the visible
 * attribution in the corner. `img-src https:` in the CSP already admits them.
 *
 * Renders nothing at all for an absent or unparseable location. A stall that
 * moves around is a normal case, not a missing value to apologise for.
 */
export function LocationMap({
  location,
  label,
  heading,
  className = '',
}: {
  location?: string
  /** Whose stall this is. Names the stall in the heading and the map's accessible name. */
  label?: string
  /**
   * Overrides the heading outright, for a reader who is not a visitor: on a
   * merchant's OWN profile "Where to find them" would call them "them".
   */
  heading?: string
  className?: string
}) {
  const parsed = parseLatLng(location)
  const point = parsed && mapPoint(parsed.lat, parsed.lng)
  if (!parsed || !point) return null

  const { tiles, pinX, pinY } = tileGrid(point.lat, point.lng, tileUrlTemplate())
  const native = Capacitor.isNativePlatform()

  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-mono-700 dark:text-mono-300">
        <MapPin className="h-4 w-4 text-mono-400" aria-hidden />
        <span>{heading ?? (label ? `Find ${label}` : 'Where to find them')}</span>
      </div>
      <div
        role="group"
        aria-label={label ? `Map showing ${label}` : 'Map showing where this stall trades'}
        className="relative overflow-hidden rounded-2xl border border-mono-200 bg-mono-100 dark:border-mono-800 dark:bg-mono-900"
        style={{ width: '100%', maxWidth: BOX_W, height: BOX_H }}
      >
        <a
          href={openInMapsHref(parsed.lat, parsed.lng)}
          {...(native ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
          className="absolute inset-0 block rounded-2xl outline-none ring-inset ring-mono-400 focus-visible:ring-2"
        >
          <div
            className="absolute"
            style={{ width: TILE * 2, height: TILE * 2, left: `calc(50% - ${pinX}px)`, top: BOX_H / 2 - pinY }}
          >
            {tiles.map((t) => (
              <img
                key={t.src}
                src={t.src}
                alt=""
                width={TILE}
                height={TILE}
                loading="lazy"
                decoding="async"
                draggable={false}
                className="absolute max-w-none"
                style={{ left: t.left, top: t.top, width: TILE, height: TILE }}
              />
            ))}
          </div>
          <MapPin
            data-testid="map-pin"
            aria-hidden
            className="absolute h-7 w-7 fill-red-500 text-red-700 drop-shadow"
            style={{ left: 'calc(50% - 14px)', top: BOX_H / 2 - 28 }}
          />
          <span className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-xs font-medium text-mono-800 shadow">
            Open in Maps
          </span>
        </a>
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-0 right-0 bg-white/85 px-1 text-[10px] text-mono-700 underline outline-none ring-mono-400 focus-visible:ring-2"
        >
          © OpenStreetMap contributors
        </a>
      </div>
    </div>
  )
}
