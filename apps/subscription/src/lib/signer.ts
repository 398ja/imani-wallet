/**
 * Signing in: the stall's own key signs each request (NIP-98), as in the wallet. No account, no
 * password, no cookie. The service learns a pubkey and nothing else (#407 §6).
 *
 * Three ways to hold the key, the same choices the wallet offers through NAP:
 *  - a NIP-07 browser extension (the key never touches this page);
 *  - a NIP-46 remote signer (`bunker://…`), e.g. the Imani wallet or nsec.app;
 *  - pasting the stall's nsec, kept in memory for this tab only and never stored.
 */
import { createNip46Signer, type Nip46Signer } from '@imani/nap-client-nip46'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils'
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'

export interface EventTemplate {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

export interface Signer {
  kind: 'extension' | 'bunker' | 'key'
  pubkey: string
  signEvent(t: EventTemplate): Promise<Record<string, unknown>>
}

interface Nip07 {
  getPublicKey(): Promise<string>
  signEvent(t: EventTemplate): Promise<Record<string, unknown>>
}

export function hasExtension(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { nostr?: Nip07 }).nostr
}

export async function extensionSigner(): Promise<Signer> {
  const nostr = (window as unknown as { nostr?: Nip07 }).nostr
  if (!nostr) throw new Error('No Nostr extension found in this browser.')
  const pubkey = (await nostr.getPublicKey()).toLowerCase()
  return { kind: 'extension', pubkey, signEvent: (t) => nostr.signEvent(t) }
}

export function keySigner(input: string): Signer {
  const value = input.trim()
  let sk: Uint8Array
  if (value.startsWith('nsec1')) {
    const d = nip19.decode(value)
    if (d.type !== 'nsec') throw new Error('That is not a secret key.')
    sk = d.data
  } else if (/^[0-9a-f]{64}$/i.test(value)) {
    sk = Uint8Array.from(value.match(/../g)!.map((h) => parseInt(h, 16)))
  } else {
    throw new Error('Paste your stall’s secret key (it starts with nsec1).')
  }
  return {
    kind: 'key',
    pubkey: getPublicKey(sk),
    signEvent: async (t) => finalizeEvent(t, sk) as unknown as Record<string, unknown>,
  }
}

export async function bunkerSigner(token: string): Promise<Signer> {
  const remote: Nip46Signer = createNip46Signer({
    connectionToken: token.trim(),
    metadata: { name: 'Imani plans', url: window.location.origin },
  })
  await remote.connect()
  const npub = await remote.getNpub()
  const pubkey = (nip19.decode(npub).data as string).toLowerCase()
  return {
    kind: 'bunker',
    pubkey,
    signEvent: (t) => remote.signEvent(t as never) as unknown as Promise<Record<string, unknown>>,
  }
}

/** `fetch` with a NIP-98 header over the exact body, as `src/lib/nip98.ts` does in the wallet. */
export async function signedFetch(signer: Signer, path: string, method: string, payload?: unknown): Promise<Response> {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const tags: string[][] = [
    ['u', new URL(path, window.location.origin).toString()],
    ['method', method],
  ]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  tags.push(['nonce', bytesToHex(crypto.getRandomValues(new Uint8Array(16)))])
  const event = await signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' })
  return fetch(path, {
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
