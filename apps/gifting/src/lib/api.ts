/**
 * The gifting site's calls: the public reads (handle resolution), the Purchase Draft API and the
 * idempotent checkout per draft (#410 §3). Same-origin through the edge, as in the wallet.
 *
 * A signed-in buyer's requests carry a NIP-98 header signed on the WALLET origin through the
 * cross-origin grant (signer.ts); a guest's carry none.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils'

import type { Draft, DraftRequest } from './draft'

export interface RemoteSigner {
  pubkey: string
  signEvent(t: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<unknown>
}

export const DRAFTS_PATH = '/api/v1/gifting/drafts'
export const PURCHASE_PATH = '/api/v1/checkout/purchase'
export const ISSUER_KEY_PATH = '/api/v1/gifting/issuer-key'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

/** Codes the server answers with that the pages turn into their own words. */
export const CODES = {
  expired: 'DRAFT_EXPIRED',
  invalidated: 'DRAFT_INVALIDATED',
  termsChanged: 'STALL_TERMS_CHANGED',
} as const

export const COPY = {
  [CODES.expired]: 'This took a while, so we checked again.',
  termsChanged: (name: string) => `${name} updated its vouchers. Please check again.`,
  unreachable: 'Could not reach the payment service. Nothing was charged.',
} as const

async function nip98(signer: RemoteSigner, url: string, method: string, body?: string): Promise<string> {
  const tags = [
    ['u', url],
    ['method', method],
  ]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = await signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' })
  return `Nostr ${btoa(JSON.stringify(event))}`
}

async function call<T>(path: string, method: string, payload: unknown, signer: RemoteSigner | null, fetchImpl: typeof fetch): Promise<T> {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const url = new URL(path, window.location.origin).toString()
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (signer) headers.Authorization = await nip98(signer, url, method, body)
  let response: Response
  try {
    // Same origin: the session cookie (if any) rides along; credentials 'same-origin' is the default.
    response = await fetchImpl(url, { method, body, headers, credentials: 'same-origin' })
  } catch {
    throw new ApiError(COPY.unreachable, 0)
  }
  const parsed = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) {
    const code = typeof parsed.error === 'string' && /^[A-Z_]+$/.test(parsed.error) ? parsed.error : undefined
    // A code is the caller's to word (it knows the stall's name); a sentence is shown verbatim.
    throw new ApiError(
      code === CODES.expired ? COPY[CODES.expired] : (parsed.error ?? `Something went wrong (${response.status}).`),
      response.status,
      code,
    )
  }
  return parsed
}

export function giftingApi(fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  return {
    /** The Purchase Issuer's public key, for sealing `ℓ` (G4). */
    issuerKey: () => call<{ pubkey: string }>(ISSUER_KEY_PATH, 'GET', undefined, null, fetchImpl).then((r) => r.pubkey),
    /** Rides the session cookie when signed in (`session.ts`); a guest's has none. */
    createDraft: (req: DraftRequest, signer: RemoteSigner | null = null) => call<Draft>(DRAFTS_PATH, 'POST', req, signer, fetchImpl),
    getDraft: (id: string) => call<Draft>(`${DRAFTS_PATH}/${encodeURIComponent(id)}`, 'GET', undefined, null, fetchImpl),
    invalidate: (id: string) =>
      call<unknown>(`${DRAFTS_PATH}/${encodeURIComponent(id)}`, 'DELETE', undefined, null, fetchImpl).catch(() => undefined),
    /** One Checkout Session per draft: a second call answers the same URL (G-R6). */
    /** One Checkout Session per draft. `returnLink` (a guest's own, G15) is emailed to them first. */
    pay: (draftId: string, returnLink?: string) =>
      call<{ checkoutUrl: string; reference: string }>(PURCHASE_PATH, 'POST', returnLink ? { draftId, returnLink } : { draftId }, null, fetchImpl),
    resolve: async (nip05: string): Promise<string | null> => {
      const r = await fetchImpl(`/api/v1/resolve/${encodeURIComponent(nip05)}`)
      if (r.status === 404 || r.status === 400) return null
      if (!r.ok) throw new Error(`resolve ${r.status}`)
      const b = (await r.json().catch(() => ({}))) as { hex_pubkey?: unknown }
      const hex = typeof b.hex_pubkey === 'string' ? b.hex_pubkey.toLowerCase() : ''
      return /^[0-9a-f]{64}$/.test(hex) ? hex : null
    },
  }
}

export type GiftingApi = ReturnType<typeof giftingApi>
