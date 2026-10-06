import { signedFetch, type RequestSigner } from './nip98'
import type { CredentialMintApi } from './credentialRevocation'
import { witnessHeaderForToken } from './witness'
import { DEFAULT_IDLE_LOCK_MINUTES } from './terminalDelivery'

/**
 * What a terminal needs at the till that the owner's wallet does not (#160 phase 3).
 *
 * A terminal has no NAP session and no account (spec 2.3), so the owner's wallet clients do not
 * fit it: the legacy `window.api` sets credentials from a session signer, and the Redeem screen's
 * paid check reads a wallet that a terminal never receives into. These are the terminal's own
 * versions, each a plain `fetch` the tests can replace:
 *
 * - `terminalMintApi`: the public NUT-07 check at unlock, and the spend that hands the credential
 *   back when the device is taken out of service;
 * - `fulfilmentOf`: whether a customer paid a payment request, from gateway-core (spec 2.5);
 * - `idleLockMs`: the owner's idle lock, from the device record (decision 2).
 */

/** The fetch this module calls. Swapped by tests. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * The terminal's mint client: `validateToken` reads, `receive` spends.
 *
 * `validateToken` is the public `POST /api/v1/wallet/token/validate`, which needs no signature,
 * so unlock can ask the mint before anything is signed. `receive` hands the credential back
 * (decommissioning): it carries the NUT-11 witness `witness.ts` signs with the unlocked terminal
 * key, which is the credential's `data` lock.
 */
export function terminalMintApi(fetchImpl: Fetch = (i, init) => fetch(i, init)): CredentialMintApi {
  return {
    async validateToken(token) {
      const res = await fetchImpl('/api/v1/wallet/token/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!res.ok) return null
      return (await res.json()) as { valid?: boolean; state?: string }
    },
    async receive(token, options) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const witnesses = witnessHeaderForToken(token)
      if (witnesses) headers['X-Cashu-Witnesses'] = witnesses
      if (options?.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
      const res = await fetchImpl('/api/v1/wallet/receive', {
        method: 'POST',
        headers,
        body: JSON.stringify({ token }),
      })
      if (!res.ok) throw new Error(`receive ${res.status}`)
      return res.json() as Promise<unknown>
    },
  }
}

/** Whether a payment request was answered: gateway-core's fulfilment record. */
export interface Fulfilment {
  fulfilled: boolean
  sendId?: string
  /** Whose coupons paid it: the registered issuer. */
  issuerId?: string
  /** Who received the counted value: the registered recipient. */
  recipientPubkey?: string
  /** Total verified value received, in minor units of `unit`. */
  amount?: number
  unit?: string
}

/** Asks whether a payment request was paid. Injected into the Redeem screen. */
export type FulfilmentCheck = (paymentRequestId: string) => Promise<Fulfilment | null>

/**
 * `GET /api/v1/atomic/fulfilment/{paymentRequestId}`, NIP-98 signed by the terminal key.
 *
 * The payment goes to the STALL (the request names it), so a terminal's own wallet never sees
 * it arrive (G12). gateway-core records the completed send against the request id, and this
 * endpoint answers for anyone holding the id: a 64-bit capability the terminal itself created.
 *
 * Null on any failure, which the screen reads as "still waiting": never paid on an error path.
 */
export function fulfilmentOf(
  signer?: RequestSigner,
  fetchSigned: typeof signedFetch = signedFetch,
): FulfilmentCheck {
  return async (paymentRequestId) => {
    try {
      const res = await fetchSigned(
        `/api/v1/atomic/fulfilment/${encodeURIComponent(paymentRequestId)}`,
        'GET',
        undefined,
        signer,
      )
      if (!res.ok) return null
      const body = (await res.json()) as Partial<Fulfilment>
      return {
        fulfilled: body.fulfilled === true,
        ...(typeof body.sendId === 'string' ? { sendId: body.sendId } : {}),
        ...(typeof body.issuerId === 'string' ? { issuerId: body.issuerId } : {}),
        ...(typeof body.recipientPubkey === 'string' ? { recipientPubkey: body.recipientPubkey } : {}),
        ...(typeof body.amount === 'number' ? { amount: body.amount } : {}),
        ...(typeof body.unit === 'string' ? { unit: body.unit } : {}),
      }
    } catch {
      return null
    }
  }
}

/** What a till asks for, registered with gateway-core before the QR code is shown. */
export interface RequestTerms {
  paymentId: string
  /** The stall: who must receive the payment, and whose coupons pay it. */
  issuerId: string
  /** Minor units. */
  amount: number
  unit: string
}

/** Registers a request's terms. Resolves true only when gateway-core holds THESE terms. */
export type RequestRegistration = (terms: RequestTerms) => Promise<boolean>

/**
 * `PUT /api/v1/atomic/fulfilment/{paymentRequestId}`, NIP-98 signed by the terminal key (#160
 * review, BLOCKER).
 *
 * gateway-core measures payments against these terms, not against anything the payer says, and
 * the first registration wins. So the till registers BEFORE it shows the QR code: once the id is
 * on screen a customer can read it, and must find the terms already taken. A 409 (someone got
 * there first with different terms) or any failure resolves false, and the screen does not show a
 * request it could never confirm.
 */
export function registerRequestTerms(
  signer?: RequestSigner,
  fetchSigned: typeof signedFetch = signedFetch,
): RequestRegistration {
  return async ({ paymentId, issuerId, amount, unit }) => {
    try {
      const res = await fetchSigned(
        `/api/v1/atomic/fulfilment/${encodeURIComponent(paymentId)}`,
        'PUT',
        { recipientPubkey: issuerId, issuerId, amount, unit },
        signer,
      )
      return res.status === 200 || res.status === 201
    } catch {
      return false
    }
  }
}

/**
 * Whether a fulfilment answers a request this terminal made for its stall (#160 review, BLOCKER).
 *
 * gateway-core now measures what really arrived, but the till checks the facts it reports anyway,
 * so a gateway that answered on the old rule (any send carrying the id) still cannot make it show
 * Paid. Every fact must be present and match:
 *
 * - the value went to the STALL, not to whoever sent it (a customer tagging a 1-sat send to
 *   themself with the id read off the QR code);
 * - it was the stall's own coupons;
 * - it is in the request's unit and at least the request's amount.
 *
 * A missing fact is a refusal: an answer that cannot be checked is not trusted.
 */
export function paidForStall(
  answer: Fulfilment | null,
  stallPubkey: string,
  request: { amount: number; unit: string },
): boolean {
  if (!answer?.fulfilled) return false
  const stall = stallPubkey.toLowerCase()
  if (answer.issuerId?.toLowerCase() !== stall) return false
  if (answer.recipientPubkey?.toLowerCase() !== stall) return false
  if (answer.unit?.toUpperCase() !== request.unit.toUpperCase()) return false
  return typeof answer.amount === 'number' && answer.amount >= request.amount
}

/**
 * The idle lock in milliseconds, or null when the owner switched it off (decision 2).
 *
 * `0` is off, missing is the default, and anything that is not a whole number of minutes reads as
 * the default rather than as off: an unreadable setting must not leave a till open all day.
 */
export function idleLockMs(minutes: number | undefined): number | null {
  if (minutes === 0) return null
  const m =
    typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0
      ? minutes
      : DEFAULT_IDLE_LOCK_MINUTES
  return m * 60_000
}

/**
 * Lock after `ms` without a touch or key press. Returns the stop function.
 *
 * Every `pointerdown` and `keydown` restarts the clock. `null` (the lock switched off) installs
 * nothing at all, so "Never" can never fire.
 */
export function startIdleLock(
  ms: number | null,
  onLock: () => void,
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  if (ms === null) return () => {}
  let timer = setTimeout(onLock, ms)
  const reset = () => {
    clearTimeout(timer)
    timer = setTimeout(onLock, ms)
  }
  target.addEventListener('pointerdown', reset)
  target.addEventListener('keydown', reset)
  return () => {
    clearTimeout(timer)
    target.removeEventListener('pointerdown', reset)
    target.removeEventListener('keydown', reset)
  }
}
