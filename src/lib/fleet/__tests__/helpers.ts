import { unzipSync, strFromU8 } from 'fflate'
import { base64, bech32 } from '@scure/base'
import { nip19 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

const enc = new TextEncoder()

/** Every encoding a value could hide in (same rule as snapshot.test.ts `forms`). */
export function forms(value: string): string[] {
  const bytes = enc.encode(value)
  const out = [value, value.toLowerCase(), bytesToHex(bytes), base64.encode(bytes), base64.encode(bytes).replace(/=+$/, '')]
  if (/^[0-9a-f]{64}$/.test(value)) {
    out.push(nip19.npubEncode(value), nip19.noteEncode(value), nip19.nprofileEncode({ pubkey: value }))
    // The raw 32 bytes, base64 and base64url, as a key could be sent.
    const raw = Uint8Array.from(value.match(/../g)!.map((h) => parseInt(h, 16)))
    out.push(base64.encode(raw), base64.encode(raw).replace(/=+$/, ''), base64.encode(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  }
  if (value.startsWith('npub1') || value.startsWith('nsec1')) {
    const words = bech32.decode(value as `${string}1${string}`, 1000).words
    out.push(bytesToHex(bech32.fromWords(words)))
  }
  return out.filter((f) => f.length >= 8)
}

export function archiveText(zip: Uint8Array): { all: string; data: string; files: Record<string, string> } {
  const files = Object.fromEntries(Object.entries(unzipSync(zip)).map(([k, v]) => [k, strFromU8(v)]))
  const all = Object.values(files).join('\n')
  const data = Object.entries(files).filter(([k]) => k.startsWith('data/')).map(([, v]) => v).join('\n')
  return { all, data, files }
}

/** Assert none of `values`, in any form, appears in `haystack`. */
export function absent(haystack: string, values: string[]): string | null {
  for (const v of values) for (const f of forms(v)) if (haystack.includes(f)) return `${v.slice(0, 16)} as ${f.slice(0, 24)}`
  return null
}
