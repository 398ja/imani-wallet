import { MapPin } from 'lucide-react'

import { parseLatLng } from '../lib/coords'

/**
 * Where a stall is, read-only, as a pin on a map.
 *
 * The merchant record has carried `location` since onboarding and `LocationField`
 * told every merchant setting it that "Customers see this as a pin on a map".
 * Nothing rendered it anywhere outside that edit field, so the promise was
 * false: a merchant could set their location, see the map while editing, and no
 * customer could ever find them.
 *
 * Extracted rather than copied out of `LocationField` because the two must not
 * drift. The embed URL is the contract — `q=lat,lng` drops the pin and
 * `output=embed` is the keyless form — and a second hand-written copy is how
 * one of them ends up with a stale query string that renders the wrong place.
 *
 * **Needs `frame-src https://www.google.com https://maps.google.com` in the
 * Content-Security-Policy**, which does NOT live in this repo: it is in
 * `nginx/conf.d/wallet.*.conf` on the imani-deploy host. Staging once shipped a
 * CSP with no `frame-src`, so the iframe fell through to `default-src 'self'`
 * and every merchant watched the map fail to load. Both `wallet.staging.conf`
 * and `wallet.prod.conf` carry the directive now — prod gained it in
 * imani-deploy `7a27f13`, added alongside this component precisely because
 * shipping a customer-facing map under prod's old policy would have drawn a
 * blank rectangle for every merchant. Verified in Chromium against both
 * policies: the frame is refused under the old one and loads under the new.
 *
 * Renders nothing at all for an absent or unparseable location. A stall that
 * moves around is a normal case, not a missing value to apologise for, and an
 * empty map frame would say less than no map.
 */
export function LocationMap({
  location,
  label,
  className = '',
}: {
  location?: string
  /** Whose stall this is, for the frame's accessible name. */
  label?: string
  className?: string
}) {
  const parsed = parseLatLng(location)
  if (!parsed) return null

  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-mono-700 dark:text-mono-300">
        <MapPin className="h-4 w-4 text-mono-400" aria-hidden />
        {/* Named for the reader, not the record: a customer wants "where to
            find them", and the merchant's own screen says "you". */}
        <span>{label ? `Find ${label}` : 'Where to find them'}</span>
      </div>
      <iframe
        title={label ? `Map showing ${label}` : 'Map showing where this stall trades'}
        src={`https://maps.google.com/maps?q=${parsed.lat},${parsed.lng}&z=15&output=embed`}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        className="h-44 w-full rounded-2xl border border-mono-200 dark:border-mono-800"
      />
    </div>
  )
}
