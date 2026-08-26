/**
 * The `"lat, lng"` string a merchant record carries as its location.
 *
 * One string rather than two fields because possa-merchant writes it that way,
 * and the record is published to a relay both apps read — see LocationField.
 */
export function parseLatLng(value: string | undefined): { lat: string; lng: string } | null {
  const parts = (value ?? '').split(',').map((s) => s.trim())
  if (parts.length !== 2) return null
  const [lat, lng] = parts
  // Number('') is 0, so the emptiness check has to come first.
  if (lat === '' || lng === '' || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) return null
  return { lat, lng }
}
