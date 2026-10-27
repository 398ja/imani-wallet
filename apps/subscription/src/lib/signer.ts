/**
 * The signed-in stall: its key, in this tab's memory only, signing each request (NIP-98).
 *
 * The key always comes from the stall's WALLET (this browser, Google Drive, or a backup file),
 * opened with the wallet passphrase; see `walletKey.ts`. There is no extension, bunker or
 * paste-your-nsec path.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils'
import { finalizeEvent, nip19 } from 'nostr-tools'

export interface EventTemplate {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

export interface Signer {
  source: 'browser' | 'drive' | 'file'
  pubkey: string
  name: string | null
  signEvent(t: EventTemplate): Promise<Record<string, unknown>>
}

export function signerFromKey(sk: Uint8Array, pubkey: string, source: Signer['source'], name: string | null): Signer {
  return {
    source,
    pubkey,
    name,
    signEvent: async (t) => finalizeEvent(t, sk) as unknown as Record<string, unknown>,
  }
}

/** The path the site is mounted under ('' or '/subscription'), from Vite's base. */
export const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '')

/** An API path on this site: '/v1/me' -> '/subscription/v1/me'. */
export const apiPath = (path: string) => `${BASE}${path}`

/** `fetch` with a NIP-98 header over the exact body, as `src/lib/nip98.ts` does in the wallet. */
export async function signedFetch(signer: Signer, path: string, method: string, payload?: unknown): Promise<Response> {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const url = new URL(apiPath(path), window.location.origin).toString()
  const tags: string[][] = [
    ['u', url],
    ['method', method],
  ]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  tags.push(['nonce', bytesToHex(crypto.getRandomValues(new Uint8Array(16)))])
  const event = await signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' })
  return fetch(url, {
    method,
    body,
    headers: {
      Authorization: `Nostr ${btoa(JSON.stringify(event))}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
  })
}

export function npubOf(pubkey: string): string {
  return nip19.npubEncode(pubkey)
}

/** Accept an npub or 64 hex, for the admin's "which stall" field. */
export function toPubkeyHex(input: string): string | null {
  const v = input.trim()
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase()
  try {
    const d = nip19.decode(v)
    return d.type === 'npub' ? (d.data as string) : null
  } catch {
    return null
  }
}
