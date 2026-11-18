import type { Event } from 'nostr-tools'

import { classifyRelayError, publish, refusedTooLarge, relayHasEvent, type PublishResult } from './relay'
import { eventBytes, WRAP_BUDGET_BYTES } from './wrapSize'

/**
 * #532: an event is DELIVERED only when the relay holds it: the relay said `OK true` and a read by
 * id from the relay itself finds it. The gateway's cache never counts, because it keeps events
 * strfry refused (a 66 KB wrap read back from nostrdb looked delivered while no relay held it).
 *
 * A relay that could not be REACHED is tried again (`attempts`); one that refused the event for its
 * size is not, because it will refuse the same bytes again: the outcome says `too_large` so the
 * caller can re-split instead of retrying forever.
 */
export type RelayDelivery = { delivered: true } | { delivered: false; why: 'too_large' | 'oversize' | 'refused' | 'unreachable' | 'not_found' }

export interface RelayDeliveryPorts {
  publish: (event: Event) => Promise<PublishResult>
  readBack: (id: string) => Promise<boolean | null>
  sleep: (ms: number) => Promise<void>
}

const WRAP_CONNECT_MS = 8_000

export const defaultRelayDeliveryPorts: RelayDeliveryPorts = {
  publish: (event) => publish(event, undefined, { connectMs: WRAP_CONNECT_MS }),
  readBack: (id) => relayHasEvent(id),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

const unreachable = (r: PublishResult) =>
  r.errors.length > 0 && (r.refusals ?? r.errors.map(classifyRelayError)).every((x) => x.kind === 'unreachable')

export async function deliverToRelay(
  event: Event,
  ports: RelayDeliveryPorts = defaultRelayDeliveryPorts,
  opts: { attempts?: number; readBacks?: number; budget?: number } = {},
): Promise<RelayDelivery> {
  const budget = opts.budget ?? WRAP_BUDGET_BYTES
  if (eventBytes(event) > budget) {
    console.error(`[relay] refusing to publish a ${eventBytes(event)}-byte kind ${event.kind}, over the ${budget}-byte budget`)
    return { delivered: false, why: 'oversize' }
  }
  const attempts = opts.attempts ?? 3
  for (let attempt = 1; ; attempt++) {
    const result = await ports.publish(event).catch((): PublishResult => ({ ok: 0, total: 1, errors: ['connection failure: threw'] }))
    if (result.ok > 0) break
    if (refusedTooLarge(result)) return { delivered: false, why: 'too_large' }
    if (!unreachable(result)) return { delivered: false, why: 'refused' }
    if (attempt >= attempts) return { delivered: false, why: 'unreachable' }
    await ports.sleep(400 * attempt)
  }
  const readBacks = opts.readBacks ?? 3
  let asked = false
  for (let i = 0; i < readBacks; i++) {
    const found = await ports.readBack(event.id).catch(() => null)
    if (found === true) return { delivered: true }
    if (found === false) asked = true
    if (i < readBacks - 1) await ports.sleep(800)
  }
  return { delivered: false, why: asked ? 'not_found' : 'unreachable' }
}
