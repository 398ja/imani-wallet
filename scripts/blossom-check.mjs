// A real BUD-01 signed upload against the local Blossom server, then a read-back.
//
//   node scripts/blossom-check.mjs <sk-hex> [server-url]
//
// Checks the media path without a browser: signs a kind-24242 auth event, PUTs a
// PNG, fetches the returned URL and compares hashes. The URL it prints is the one
// the server derived from the Host header — if that is not reachable from a
// browser, avatars will 404 in the app while this stack looks healthy.
//
// It exercises /upload. The WALLET uploads through /media (BUD-05), which is a
// different endpoint with its own `enabled` flag and which re-encodes the image —
// so this passing does not prove the app works. deploy/blossom.yml turns /media on.
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'

const SERVER = process.argv[3] ?? 'http://localhost:28089'
const priv = hexToBytes(process.argv[2])
console.log('uploader:', getPublicKey(priv).slice(0, 16) + '…')

// A 1x1 PNG — smallest real image that exercises the image/* storage rule.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const hash = bytesToHex(sha256(png))
const now = Math.floor(Date.now() / 1000)

const auth = finalizeEvent({
  kind: 24242,
  created_at: now,
  tags: [['t', 'upload'], ['x', hash], ['expiration', String(now + 300)]],
  content: 'Upload avatar',
}, priv)

const res = await fetch(`${SERVER}/upload`, {
  method: 'PUT',
  headers: {
    'content-type': 'image/png',
    Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`,
  },
  body: png,
})
const body = await res.text()
console.log(`PUT /upload → ${res.status}`)
console.log(body.slice(0, 300))

if (res.ok) {
  const url = JSON.parse(body).url
  const back = await fetch(url)
  console.log(`\nGET ${url} → ${back.status} ${back.headers.get('content-type')}`)
  const bytes = Buffer.from(await back.arrayBuffer())
  console.log(`round-trip identical: ${bytesToHex(sha256(bytes)) === hash}`)
}
