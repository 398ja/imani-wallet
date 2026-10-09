import type { Event, EventTemplate } from 'nostr-tools'

import { getSigner } from './nap'
import { allEvents, publish } from './relay'
import { gatewayEvents } from './gatewayNostr'
import { mirrorToGateway } from './transferSignature'
import { buildRecordEvents, isChunkEvent, reassembleRecords, recordIdOf, type Sealer } from './chunkedRecord'
import { onRosterChanged } from './terminalRoster'
import { syncRoster } from './terminalRosterSync'
import { markSpentElsewhere } from './terminalRevoke'
import { legacyApi } from './legacyBridge'
import type { CredentialMintApi } from './credentialRevocation'

/**
 * The network half of the roster sync (#160 phase 6, plan 2.2): kind 30078, `d=imani:terminals`,
 * NIP-44 sealed to the stall's own key, the pattern of `issuerDelegation.ts` and
 * `voucherRecords.ts`. Published to the relay and mirrored to the gateway, read from both. A
 * roster too big for one event goes out in `chunkedRecord`'s chunk format (F9).
 */

export const ROSTER_KIND = 30078
export const ROSTER_D_TAG = 'imani:terminals'

function selfSealer(): Sealer {
  const signer = getSigner()
  return {
    encrypt: (plain) => signer.nip44Encrypt(signer.pubkey, plain),
    decrypt: (cipher) => signer.nip44Decrypt(signer.pubkey, cipher),
  }
}

/** The newest roster plaintext this stall published, or null. Throws only when nothing answered. */
export async function fetchRosterPlaintext(stallPubkey: string): Promise<string | null> {
  let reached = false
  const [relayed, cached] = await Promise.all([
    allEvents(stallPubkey, ROSTER_KIND).then(
      (e) => ((reached = true), e),
      () => [] as Event[],
    ),
    gatewayEvents(stallPubkey, ROSTER_KIND).then((e) => {
      // The gateway answers [] on any failure, so only a non-empty answer proves it was reached.
      if (e.length > 0) reached = true
      return e
    }),
  ])
  if (!reached) throw new Error('neither the relay nor the gateway answered')
  const mine = [...relayed, ...cached].filter(
    (e) => e.pubkey === stallPubkey && (recordIdOf(e) === ROSTER_D_TAG),
  )
  const unique = [...new Map(mine.map((e) => [e.id, e])).values()]
  const candidates: Array<{ at: number; plaintext: string }> = []
  for (const r of await reassembleRecords(unique, stallPubkey, selfSealer())) {
    candidates.push({ at: r.at, plaintext: r.plaintext })
  }
  const sealer = selfSealer()
  for (const e of unique) {
    if (isChunkEvent(e)) continue
    try {
      candidates.push({ at: e.created_at, plaintext: sealer.decrypt(e.content) })
    } catch {
      // Not ours to read. The next one may be.
    }
  }
  candidates.sort((a, b) => b.at - a.at)
  return candidates[0]?.plaintext ?? null
}

/** Sign and publish every event of the roster record. True when every event landed somewhere. */
export async function publishRosterPlaintext(plaintext: string): Promise<boolean> {
  const signer = getSigner()
  const templates: EventTemplate[] = await buildRecordEvents(ROSTER_KIND, ROSTER_D_TAG, plaintext, [], selfSealer())
  let all = true
  for (const template of templates) {
    const event = await signer.signEvent(template)
    const [relayed, mirrored] = await Promise.all([
      publish(event).then(
        (r) => r.ok > 0,
        () => false,
      ),
      mirrorToGateway(event as Event),
    ])
    if (!relayed && !mirrored) all = false
  }
  return all
}

async function ownerMint(): Promise<CredentialMintApi> {
  return (await legacyApi()) as unknown as CredentialMintApi
}

/**
 * Fetch, merge into local, publish, then let the mint correct anything revoked elsewhere, so a
 * restored roster shows revocations at once. Never throws.
 */
export async function syncRosterNow(stallPubkey: string): Promise<boolean> {
  try {
    const out = await syncRoster(stallPubkey, {
      fetch: fetchRosterPlaintext,
      publish: publishRosterPlaintext,
      afterMerge: async (stall) => void (await markSpentElsewhere(stall, await ownerMint())),
    })
    return out.fetched
  } catch (error) {
    console.warn('[rosterSync] roster not synced', error)
    return false
  }
}

const DEBOUNCE_MS = 2_000
let stop: (() => void) | null = null

/**
 * Publish every roster change, debounced, as a read-merge-publish (so a write from the other
 * phone is merged in, never overwritten). Started on login; stopped on logout.
 */
export function startRosterSync(stallPubkey: string): () => void {
  stop?.()
  let timer: ReturnType<typeof setTimeout> | undefined
  const off = onRosterChanged((stall) => {
    if (stall !== stallPubkey) return
    clearTimeout(timer)
    timer = setTimeout(() => void syncRosterNow(stallPubkey), DEBOUNCE_MS)
  })
  stop = () => {
    clearTimeout(timer)
    off()
    stop = null
  }
  return stop
}

export function stopRosterSync(): void {
  stop?.()
}
