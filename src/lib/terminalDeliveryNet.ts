import type { Event } from 'nostr-tools'

import { getSigner } from './nap'
import { publish } from './relay'
import { mirrorToGateway } from './transferSignature'
import { liveTerminals, markInService, waitingTerminals } from './terminalRoster'
import { adoptRenewRequest, completeRenewals } from './terminalRenewOwner'
import { renewRequestFromRumor } from './terminalRenewal'
import { legacyApi } from './legacyBridge'
import type { CredentialMintApi } from './credentialRevocation'
import { enrolledNotices, giftWrapsFor, unwrapSealed, type WrapPublisher } from './terminalDelivery'
import { signedFetch, type RequestSigner } from './nip98'

/**
 * The network half of terminal delivery (#160 phase 2): relay plus gateway mirror, the way the
 * transfer signature publishes (`transferSignature.ts`, #98), and reads from both.
 *
 * Kept apart from `terminalDelivery.ts` so that module's rules stay testable with no network.
 */

/** Relay and gateway mirror, side by side. Either landing counts as delivered. */
export const ownerPublisher: WrapPublisher = {
  publish: async (wrap) => {
    const [relayed, mirrored] = await Promise.all([
      publish(wrap).then(
        (r) => r.ok > 0,
        () => false,
      ),
      mirrorToGateway(wrap),
    ])
    return relayed || mirrored
  },
}

/**
 * Relay and gateway mirror for a device with no session: the mirror is NIP-98 signed by the
 * terminal's own key, lent by `completeEnrolment`.
 */
export function devicePublisher(signer: RequestSigner): WrapPublisher {
  return {
    publish: async (wrap) => {
      const mirror = signedFetch(
        '/api/v1/nostr/events',
        'POST',
        {
          id: wrap.id,
          pubkey: wrap.pubkey,
          createdAt: wrap.created_at,
          kind: wrap.kind,
          tags: wrap.tags,
          content: wrap.content,
          sig: wrap.sig,
        },
        signer,
      ).then(
        (r) => r.ok,
        () => false,
      )
      const [relayed, mirrored] = await Promise.all([
        publish(wrap).then(
          (r) => r.ok > 0,
          () => false,
        ),
        mirror,
      ])
      return relayed || mirrored
    },
  }
}

/**
 * Gift wraps for `pubkey`, deduplicated. Never throws. Through the gateway only (owner rule, #428):
 * its query merges a live relay read server-side, so nothing is lost by not asking strfry here.
 */
export async function giftWraps(pubkey: string, sinceSeconds?: number): Promise<Event[]> {
  const seen = new Map<string, Event>()
  for (const e of await giftWrapsFor(pubkey, sinceSeconds)) seen.set(e.id, e)
  return [...seen.values()]
}

/**
 * Promote waiting rows whose device has confirmed (owner side). Returns how many changed.
 *
 * Reads only when something is waiting, so an owner with no setup in progress pays nothing.
 */
export async function collectEnrolled(
  stallPubkey: string,
  api?: () => Promise<CredentialMintApi>,
): Promise<number> {
  const waiting = waitingTerminals(stallPubkey)
  // Renewals waiting for their device count too (#160 phase 6): the enrolled DM for the NEW
  // voucher is what retires the old credential.
  const renewing = liveTerminals(stallPubkey).filter((t) => t.renewal?.token)
  if (waiting.length === 0 && renewing.length === 0) return 0
  const since = Math.floor(
    Math.min(...waiting.map((t) => t.enrolledAt), ...renewing.map((t) => t.renewal!.startedAt)) / 1000,
  )
  const wraps = await giftWraps(stallPubkey, since)
  const notices = enrolledNotices(wraps, (wrap) =>
    getSigner().withPrivkey((key) => unwrapSealed(wrap, key)),
  )
  let changed = 0
  for (const n of notices) {
    if (markInService(stallPubkey, n.terminalPubkey, n.voucherId)) changed += 1
  }
  if (renewing.length > 0 && notices.length > 0) {
    const mint = await (api ?? ownerMintApi)()
    changed += await completeRenewals(stallPubkey, notices, mint)
  }
  return changed
}

async function ownerMintApi(): Promise<CredentialMintApi> {
  return (await legacyApi()) as unknown as CredentialMintApi
}

/**
 * Renew requests from tills the owner's list lost (#160 phase 6, Q3): each one that is this
 * stall's own, unspent credential, held by the till that sealed it, becomes a row the owner can
 * Renew. Never throws.
 *
 * @returns how many rows were added or marked as asking
 */
export async function collectRenewRequests(stallPubkey: string, api?: () => Promise<CredentialMintApi>): Promise<number> {
  try {
    const since = Math.floor(Date.now() / 1000) - 30 * 86_400
    const wraps = await giftWraps(stallPubkey, since)
    const mint = await (api ?? ownerMintApi)()
    let changed = 0
    for (const wrap of wraps) {
      const opened = getSigner().withPrivkey((key) => unwrapSealed(wrap, key))
      if (!opened) continue
      const request = renewRequestFromRumor(opened.rumor, opened.sealer, stallPubkey)
      if (typeof request === 'string') {
        if (request !== 'not-a-renew-request') console.warn('[renewal] renew request refused', request)
        continue
      }
      const out = await adoptRenewRequest(stallPubkey, request, mint, opened.rumor.created_at * 1000)
      if (out === 'adopted' || out === 'already-listed') changed += 1
    }
    return changed
  } catch {
    return 0
  }
}
