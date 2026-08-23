import { useState } from 'react'

import { Button, Input } from './ui'
import { parseLatLng } from '../lib/coords'

/**
 * Where the stall is, as coordinates.
 *
 * Kept as the single `"lat, lng"` STRING possa-merchant writes rather than two
 * record fields, and that is the whole reason `parseLatLng` exists: the merchant
 * record is published to a relay both apps read, so splitting it into `lat` and
 * `lng` here would make every record this app writes unreadable to that one. A
 * ten-line parser is cheaper than a fork of the schema.
 *
 * The map is Google's keyless `output=embed` form — no API key to configure,
 * none to leak. It DOES need `frame-src https://www.google.com
 * https://maps.google.com` in the Content-Security-Policy, and that policy does
 * not live in this repo's `deploy/nginx.conf` (which still ships none) but in
 * `nginx/conf.d/wallet.*.conf` on the imani-deploy host. Staging grew a CSP with
 * no `frame-src`, so it fell through to `default-src 'self'` and every merchant
 * watched this map fail to load — the requirement was written down here and the
 * policy was added somewhere this file cannot see.
 */

export function LocationField({
  value,
  onChange,
  disabled,
}: {
  value?: string
  onChange: (next: string) => void
  disabled?: boolean
}) {
  // The two halves are held here, not derived from `value` on every render.
  // "51." and "51.5, " are states a merchant types through, and neither
  // survives a round trip out to a joined string and back.
  const [{ lat, lng }, setPair] = useState(() => parseLatLng(value) ?? { lat: '', lng: '' })
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const emit = (next: { lat: string; lng: string }) => {
    setPair(next)
    const l = next.lat.trim()
    const g = next.lng.trim()
    onChange(l !== '' && g !== '' ? `${l}, ${g}` : '')
  }

  const locate = () => {
    // Checked for a value, not a key: some embedded browsers define the
    // property and leave it null.
    if (!navigator.geolocation) {
      setError('This device cannot report its location. Type the coordinates instead.')
      return
    }
    setLocating(true)
    setError(null)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        emit({
          lat: position.coords.latitude.toFixed(6),
          lng: position.coords.longitude.toFixed(6),
        })
        setLocating(false)
      },
      (e) => {
        setError(
          e.code === e.PERMISSION_DENIED
            ? 'Location permission denied. Type the coordinates instead.'
            : 'Could not get your location. Type the coordinates instead.',
        )
        setLocating(false)
      },
      // Street-level accuracy is all a map pin needs, and the cheap fix beats
      // the GPS one for the seconds it saves standing in a doorway.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    )
  }

  const parsed = parseLatLng(value)

  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-mono-700 dark:text-mono-300">
        Where you trade
      </span>

      <div className="flex gap-2">
        <Input
          aria-label="Latitude"
          type="number"
          step="any"
          inputMode="decimal"
          placeholder="Latitude"
          value={lat}
          onChange={(e) => emit({ lat: e.target.value, lng })}
          disabled={disabled}
        />
        <Input
          aria-label="Longitude"
          type="number"
          step="any"
          inputMode="decimal"
          placeholder="Longitude"
          value={lng}
          onChange={(e) => emit({ lat, lng: e.target.value })}
          disabled={disabled}
        />
      </div>

      <div className="mt-2 flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={disabled || locating} onClick={locate}>
          {locating ? 'Locating…' : 'Use my location'}
        </Button>
        {parsed && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => emit({ lat: '', lng: '' })}
            className="pressable text-sm text-mono-500 underline disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>

      {error && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {parsed && (
        <iframe
          title="Map of where you trade"
          // `q=lat,lng` drops a pin; `output=embed` is the form that needs no key.
          src={`https://maps.google.com/maps?q=${parsed.lat},${parsed.lng}&z=15&output=embed`}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          className="mt-3 h-44 w-full rounded-2xl border border-mono-200 dark:border-mono-800"
        />
      )}

      <p className="mt-1.5 text-xs text-mono-500">
        Customers see this as a pin on a map. Leave it blank if you move around.
      </p>
    </div>
  )
}
