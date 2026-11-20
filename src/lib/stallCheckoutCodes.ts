/**
 * Does this stall's online shop take NEW checkout codes? Asked before Get code (#639).
 *
 * `GET /api/v1/wallet/stalls/{stall}/checkout-codes` (gateway-customer) answers
 * `{"accepts_new": boolean}`, from the stall's plan, and nothing about the plan itself. A public read:
 * no signature.
 *
 * Fails OPEN: `null` (unknown) for anything but a clear answer, a 503 (licence store down), a 404
 * (a gateway older than the route), a network error or a malformed body. The caller then leaves
 * Get code on and the lock decides, as before. Only a clear `false` turns it off.
 */
export const stallCheckoutCodesPath = (stall: string) => `/api/v1/wallet/stalls/${encodeURIComponent(stall.toLowerCase())}/checkout-codes`

export async function stallAcceptsNewCheckoutCodes(stall: string, fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(stall)) return null
  try {
    const response = await fetchImpl(stallCheckoutCodesPath(stall), { method: 'GET', headers: { Accept: 'application/json' } })
    if (response.status !== 200) return null
    const body = (await response.json()) as { accepts_new?: unknown } | null
    return typeof body?.accepts_new === 'boolean' ? body.accepts_new : null
  } catch {
    return null
  }
}
