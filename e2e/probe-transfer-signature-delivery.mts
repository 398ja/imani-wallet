/**
 * Does a wallet-published transfer-signature wrap reach an OFFLINE recipient's
 * catch-up? (#98, ADR 0014 "Delivery")
 *
 * The sender's kind-1059 NIP-17 wrap is published by the wallet to the relay.
 * The gateway sees it only through a live SSE subscription (the recipient here
 * has none) or through the catch-up `/api/v1/nostr/query`, whose caching layer
 * may answer from its local store without asking the relay. This probe runs
 * that catch-up exactly as `DmPollService.fetchRecentDms` does
 * (`{kinds:[1059], pTags:[me], since: now-7d, limit: 50}`) in five arms, each
 * with a fresh throwaway recipient so no arm can warm another:
 *
 *   cold              relay-only wrap, nothing cached for B
 *   warm              a fresh 1059 for B already cached (stored via
 *                     POST /api/v1/nostr/events), then the relay-only wrap
 *   warm-other        a fresh 1059 cached for someone ELSE (C), then a
 *                     relay-only wrap to B (does freshness leak across #p?)
 *   warm+mirror       as `warm`, but the wrap is ALSO posted to
 *                     POST /api/v1/nostr/events (the wallet fix)
 *   mirror-only       the wrap goes ONLY to POST /api/v1/nostr/events, never
 *                     to the relay (is the mirror alone enough?)
 *
 * Every identity is generated here and thrown away. The only things published
 * are gift wraps between those identities, plus the cache warmers, which go to
 * the gateway cache only and never to the relay.
 *
 *   GATEWAY_URL=https://wallet.staging.398ja.xyz npx tsx e2e/probe-transfer-signature-delivery.mts
 */
import { finalizeEvent, nip17, type Event } from 'nostr-tools'
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import WebSocket from 'ws'

useWebSocketImplementation(WebSocket)

const GATEWAY = (process.env.GATEWAY_URL ?? 'https://wallet.staging.398ja.xyz').replace(/\/$/, '')

interface Id {
  sk: Uint8Array
  pk: string
}
function identity(): Id {
  const sk = secp256k1.utils.randomSecretKey()
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}

function nip98(id: Id, url: string, method: string, body: string): string {
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', url],
        ['method', method],
        ['payload', bytesToHex(sha256(new TextEncoder().encode(body)))],
        ['nonce', bytesToHex(randomBytes(16))],
      ],
      content: '',
    },
    id.sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

/** POST /api/v1/nostr/events, the payload shape shared/api.js mirrors with. */
async function storeEvent(caller: Id, event: Event): Promise<number> {
  const url = `${GATEWAY}/api/v1/nostr/events`
  const body = JSON.stringify({
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  })
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: nip98(caller, url, 'POST', body) },
    body,
  })
  return r.status
}

/** The wallet's catch-up, as DmPollService.fetchRecentDms issues it. */
async function catchUp(recipient: string): Promise<string[]> {
  const r = await fetch(`${GATEWAY}/api/v1/nostr/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kinds: [1059],
      pTags: [recipient],
      since: Math.floor(Date.now() / 1000) - 7 * 86400,
      limit: 50,
    }),
  })
  if (!r.ok) throw new Error(`nostr/query ${r.status}`)
  const body = (await r.json()) as { events?: { id: string }[] }
  return (body.events ?? []).map((e) => e.id)
}

/**
 * A fresh 1059 addressed to `to`, created NOW so it sits inside the 30-minute
 * freshness window. Its content is not a real rumor: nothing will ever unwrap
 * it, it only has to be a validly signed kind 1059 tagged `p`.
 */
function warmer(to: string): Event {
  return finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', to]],
      content: `probe-98-warmer-${bytesToHex(randomBytes(8))}`,
    },
    identity().sk,
  )
}

/** The wrap, built exactly as sendTransferSignature builds it. */
function wrap(from: Id, to: string): Event {
  return nip17.wrapEvent(
    from.sk,
    { publicKey: to },
    JSON.stringify({ type: 'probe_98_transfer_signature', note: 'throwaway identities, no value' }),
  ) as Event
}

async function relayUrl(): Promise<string> {
  if (process.env.RELAY_URL) return process.env.RELAY_URL
  const r = await fetch(`${GATEWAY}/api/v1/config`)
  if (!r.ok) throw new Error(`config ${r.status}`)
  return ((await r.json()) as { relay_url: string }).relay_url
}

type Arm = 'cold' | 'warm' | 'warm-other' | 'warm+mirror' | 'mirror-only'

async function run(arm: Arm, relay: Relay) {
  const A = identity()
  const B = identity()
  const C = identity()
  const notes: string[] = []

  if (arm === 'warm' || arm === 'warm+mirror') {
    notes.push(`warm B: ${await storeEvent(A, warmer(B.pk))}`)
  }
  if (arm === 'warm-other') {
    notes.push(`warm C: ${await storeEvent(A, warmer(C.pk))}`)
    // Prime the gateway's view of C too, so the warmer is in play.
    await catchUp(C.pk)
  }
  // A catch-up BEFORE the wrap exists, for the warm arms: it is what a real
  // wallet polling every few minutes would have done, and it proves the warmer
  // is served back (so the cache is genuinely warm for B).
  if (arm === 'warm' || arm === 'warm+mirror') {
    notes.push(`pre-catch-up returned ${(await catchUp(B.pk)).length}`)
  }

  const w = wrap(A, B.pk)
  if (arm !== 'mirror-only') {
    await relay.publish(w)
    notes.push('relay: ok')
  }
  if (arm === 'warm+mirror' || arm === 'mirror-only') {
    notes.push(`mirror: ${await storeEvent(A, w)}`)
  }

  // Give strfry a moment; the question is the gateway's cache, not latency.
  await new Promise((r) => setTimeout(r, 1500))
  const first = await catchUp(B.pk)
  await new Promise((r) => setTimeout(r, 5000))
  const second = await catchUp(B.pk)
  return {
    arm,
    wrapCreatedAgoMin: Math.round((Date.now() / 1000 - w.created_at) / 60),
    delivered1: first.includes(w.id),
    delivered2: second.includes(w.id),
    returned: second.length,
    notes: notes.join('; '),
  }
}

async function main() {
  console.log(`gateway ${GATEWAY}`)
  const url = await relayUrl()
  console.log(`relay   ${url}`)
  const relay = await Relay.connect(url)
  const arms: Arm[] = ['cold', 'warm', 'warm-other', 'warm+mirror', 'mirror-only']
  const rows = []
  for (const arm of arms) {
    try {
      rows.push(await run(arm, relay))
    } catch (error) {
      rows.push({ arm, error: String(error) })
    }
  }
  relay.close()
  console.table(rows)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
