/**
 * Is a stall open for business? (imani-wallet#434, imani-gateway-portal#96)
 *
 * Asked of the portal, not read from the relay directly: the portal verifies the stall's own
 * signed record (NIP-01), so a forged "closed" or "open" published by somebody else changes
 * nothing, and it answers the same for every wallet, terminal and checkout.
 *
 * Four answers, and the caller fails CLOSED on the last two: a customer must not pay a stall
 * nobody could confirm is open, and a till must not sell for one.
 *
 *   open      a merchant that is trading
 *   closed    a merchant that has switched Open for business off
 *   customer  no stall record (404): not a merchant at all
 *   unknown   the portal could not say (503, network, timeout)
 */

export type OpenStatus = 'open' | 'closed' | 'customer' | 'unknown'

export type StallStatus = {
  status: OpenStatus
  /** Cards are sold only by an open stall that accepts them. False unless the portal said so. */
  sellsByCard: boolean
  /** The signed record that set the answer, for ETag polling. */
  eventId?: string
}

const PATH = '/api/v1/portal/merchants/public/'
const TIMEOUT_MS = 6000

const UNKNOWN: StallStatus = { status: 'unknown', sellsByCard: false }

/** Seam for tests. */
export const statusTransport = {
  fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
}

/** Last answer per stall, so a poll can send If-None-Match and reuse the body on 304. */
const lastByStall = new Map<string, StallStatus>()

export function forgetStallStatus(): void {
  lastByStall.clear()
}

export async function fetchStallStatus(stallPubkey: string): Promise<StallStatus> {
  const key = (stallPubkey ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(key)) return UNKNOWN

  const previous = lastByStall.get(key)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (previous?.eventId) headers['If-None-Match'] = `"${previous.eventId}"`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await statusTransport.fetch(`${PATH}${key}/status`, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    })
    if (response.status === 304 && previous) return previous
    if (response.status === 404) {
      const answer: StallStatus = { status: 'customer', sellsByCard: false }
      lastByStall.set(key, answer)
      return answer
    }
    if (response.status !== 200) return UNKNOWN

    const body = (await response.json()) as {
      merchant?: unknown
      open?: unknown
      sellsByCard?: unknown
      eventId?: unknown
    }
    if (body.merchant !== true || typeof body.open !== 'boolean') return UNKNOWN
    const answer: StallStatus = {
      status: body.open ? 'open' : 'closed',
      sellsByCard: body.open === true && body.sellsByCard === true,
      eventId: typeof body.eventId === 'string' ? body.eventId : undefined,
    }
    lastByStall.set(key, answer)
    return answer
  } catch {
    return UNKNOWN
  } finally {
    clearTimeout(timer)
  }
}

/** True only for a confirmed open stall. Everything else is a reason not to trade. */
export function mayTradeWith(status: OpenStatus): boolean {
  return status === 'open'
}

/** The one sentence a customer sees when they cannot pay, by reason. */
export function closedMessage(status: OpenStatus, name?: string): string | null {
  const who = name && name.trim() ? name.trim() : 'This merchant'
  if (status === 'closed') return `${who} is closed right now. Your vouchers are safe. Try again when they reopen.`
  if (status === 'unknown') return `We can't check whether ${who === 'This merchant' ? 'this merchant' : who} is open right now. Try again in a moment.`
  return null
}
