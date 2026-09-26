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
 * Cleanup. The probe keeps the key of every event it publishes, the gift
 * wrap's own NIP-59 throwaway key included (it builds the wrap itself rather
 * than letting `nip17.wrapEvent` pick and discard one). At the end it
 * publishes a NIP-09 deletion request (kind 5, `e` and `k` tags) for each of
 * them, signed by that event's author, and prints what was and was not
 * accepted. What that does and does not remove:
 *
 *   - Relay (strfry, which implements NIP-09): each wrap the probe published
 *     there gets a deletion request from its own author, and the script
 *     prints how many the relay accepted. The kind-5 requests themselves
 *     stay, as junk signed by keys nobody holds once the probe exits.
 *   - Gateway cache (nostrdb, via POST /api/v1/nostr/events): NOT removed.
 *     `storeEvent` stores what it is given and never applies a kind 5, and
 *     there is no delete endpoint. The warmers and the mirrored wraps stay in
 *     staging nostrdb until it is pruned or reset by someone with admin
 *     access. They are harmless: tagged to throwaway recipients whose keys are
 *     discarded when the probe exits. The deletions are not sent there, since
 *     they would only add more events it keeps.
 *   - Seals (kind 13) and NIP-98 auth events (kind 27235) are never published,
 *     so there is nothing to remove.
 *   - Runs before this cleanup existed (the #98 staging run) discarded the
 *     wrap keys, so their wraps cannot be deleted by anyone but a relay admin.
 *
 * Set PROBE_KEEP=1 to skip the cleanup and leave the events in place.
 *
 *   GATEWAY_URL=https://wallet.staging.398ja.xyz npx tsx e2e/probe-transfer-signature-delivery.mts
 */
import { finalizeEvent, nip44, nip59, type Event } from 'nostr-tools'
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import WebSocket from 'ws'

useWebSocketImplementation(WebSocket)

const GATEWAY = (process.env.GATEWAY_URL ?? 'https://wallet.staging.398ja.xyz').replace(/\/$/, '')

/** Every event this run put anywhere, with the key that can ask to delete it. */
const published: Array<{ event: Event; sk: Uint8Array; where: 'relay' | 'gateway cache' }> = []

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
function warmer(to: string): { event: Event; sk: Uint8Array } {
  const { sk } = identity()
  const event = finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', to]],
      content: `probe-98-warmer-${bytesToHex(randomBytes(8))}`,
    },
    sk,
  )
  return { event, sk }
}

/**
 * The wrap, built as `nip17.wrapEvent` (what sendTransferSignature calls)
 * builds it: a kind-14 rumor, sealed by the sender, wrapped with a one-off
 * key, `created_at` backdated up to two days. The one difference is that the
 * one-off wrap key is returned rather than discarded, so the wrap can be
 * deleted afterwards.
 */
export function wrap(from: Id, to: string): { event: Event; sk: Uint8Array } {
  const rumor = nip59.createRumor(
    {
      kind: 14,
      created_at: Math.ceil(Date.now() / 1000),
      tags: [['p', to]],
      content: JSON.stringify({ type: 'probe_98_transfer_signature', note: 'throwaway identities, no value' }),
    },
    from.sk,
  )
  const seal = nip59.createSeal(rumor, from.sk, to)
  const { sk } = identity()
  const event = finalizeEvent(
    {
      kind: 1059,
      created_at: Math.round(Date.now() / 1000 - Math.random() * 2 * 24 * 60 * 60),
      tags: [['p', to]],
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(sk, to)),
    },
    sk,
  )
  return { event, sk }
}

/** A NIP-09 deletion request for `event`, signed by its author's key. */
export function deletionFor(event: Event, sk: Uint8Array): Event {
  return finalizeEvent(
    {
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', event.id],
        ['k', String(event.kind)],
      ],
      content: 'probe-98 cleanup: throwaway test event',
    },
    sk,
  )
}

/**
 * Ask the relay to delete everything this run published. Never throws: a
 * cleanup failure is reported, not fatal, and must not hide the results.
 */
async function cleanup(relay: Relay): Promise<void> {
  let relayDeleted = 0
  const failures: string[] = []
  const onRelay = published.filter((p) => p.where === 'relay')
  for (const { event, sk } of onRelay) {
    try {
      await relay.publish(deletionFor(event, sk))
      relayDeleted++
    } catch (error) {
      failures.push(`${event.id.slice(0, 8)}: ${String(error)}`)
    }
  }
  const cacheOnly = published.filter((p) => p.where === 'gateway cache').length
  console.log(
    `cleanup: ${relayDeleted}/${onRelay.length} deletion requests accepted by the relay` +
      (failures.length ? `; refused: ${failures.join(', ')}` : ''),
  )
  console.log(
    `cleanup: ${cacheOnly} event(s) sent to the gateway cache stay there (no NIP-09 there, see the header)`,
  )
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
    const w = warmer(B.pk)
    published.push({ ...w, where: 'gateway cache' })
    notes.push(`warm B: ${await storeEvent(A, w.event)}`)
  }
  if (arm === 'warm-other') {
    const w = warmer(C.pk)
    published.push({ ...w, where: 'gateway cache' })
    notes.push(`warm C: ${await storeEvent(A, w.event)}`)
    // Prime the gateway's view of C too, so the warmer is in play.
    await catchUp(C.pk)
  }
  // A catch-up BEFORE the wrap exists, for the warm arms: it is what a real
  // wallet polling every few minutes would have done, and it proves the warmer
  // is served back (so the cache is genuinely warm for B).
  if (arm === 'warm' || arm === 'warm+mirror') {
    notes.push(`pre-catch-up returned ${(await catchUp(B.pk)).length}`)
  }

  const { event: w, sk: wrapSk } = wrap(A, B.pk)
  if (arm !== 'mirror-only') {
    published.push({ event: w, sk: wrapSk, where: 'relay' })
    await relay.publish(w)
    notes.push('relay: ok')
  }
  if (arm === 'warm+mirror' || arm === 'mirror-only') {
    // In the relay-and-mirror arm it is already listed; the relay copy is the
    // one a deletion can remove.
    if (arm === 'mirror-only') published.push({ event: w, sk: wrapSk, where: 'gateway cache' })
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
  console.table(rows)
  if (process.env.PROBE_KEEP === '1') console.log('cleanup: skipped (PROBE_KEEP=1)')
  else await cleanup(relay)
  relay.close()
}

// Only when run, not when imported (the wrap and deletion builders are checked
// offline by importing them).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
