#!/usr/bin/env node
/**
 * Sign a request for the wallet API, and print the Authorization header.
 *
 * Exists because "usable with plain HTTP tooling" is a real requirement and
 * curl cannot sign. Without this, the shortest path to a first successful
 * request is writing a program, which is precisely the barrier the requirement
 * is about.
 *
 *   node services/wallet-api/sign.mjs <nsec-or-hex> <method> <url> [body-file]
 *
 * The body is read as BYTES from a file and hashed exactly as read. Passing it
 * as an argument would invite a shell to alter it — and a body that differs by
 * one byte from what was signed is refused as `payload-mismatch`, which is a
 * confusing way to learn about quoting.
 *
 * Prints only the header, so it composes:
 *
 *   curl -H "Authorization: $(node .../sign.mjs $KEY POST $URL holding.json)" \
 *        --data-binary @holding.json $URL
 */
import { readFileSync } from 'node:fs'

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'

const [, , key, method, url, bodyFile] = process.argv

if (!key || !method || !url) {
  console.error('usage: sign.mjs <nsec|hex|"new"> <method> <url> [body-file]')
  console.error('')
  console.error('  sign.mjs new GET http://localhost:8788/v1/whoami')
  console.error('  sign.mjs $NSEC POST http://localhost:8788/v1/holding/value holding.json')
  process.exit(2)
}

/** An nsec, a hex secret, or `new` for a throwaway identity to try the API with. */
function secretFrom(input) {
  if (input === 'new') {
    const secret = generateSecretKey()
    // To stderr, so `$(...)` still captures only the header.
    console.error(`# new identity: ${nip19.npubEncode(getPublicKey(secret))}`)
    return secret
  }
  if (input.startsWith('nsec1')) {
    const { type, data } = nip19.decode(input)
    if (type !== 'nsec') throw new Error(`expected an nsec, got a ${type}`)
    return data
  }
  if (!/^[0-9a-f]{64}$/i.test(input)) {
    throw new Error('expected an nsec, a 64-character hex secret, or "new"')
  }
  return hexToBytes(input.toLowerCase())
}

const secret = secretFrom(key)

const tags = [
  // Absolute, and including the query string: the signature covers the
  // arguments, so a signed request cannot be replayed against different ones.
  ['u', new URL(url).toString()],
  ['method', method.toUpperCase()],
]

if (bodyFile) {
  // Read as bytes and hashed as read. Any re-encoding here would produce a
  // hash that does not match what curl sends.
  tags.push(['payload', bytesToHex(sha256(readFileSync(bodyFile)))])
}

// A nonce, for the same reason `src/lib/nip98.ts` carries one: `created_at` is
// in SECONDS and the other tags are a pure function of the request, so two
// curl calls in the same second would produce a byte-identical event and the
// second would be refused as a replay. Two invocations of this script are
// exactly that case.
tags.push(['nonce', bytesToHex(randomBytes(16))])

const event = finalizeEvent(
  { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
  secret,
)

process.stdout.write(`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}\n`)
