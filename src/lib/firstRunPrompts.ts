/**
 * The owner's answers to the two first-run questions: "Turn on notifications?" and "Help improve Imani
 * by sharing anonymised health checks?". Asked once each, like the receipt acknowledgement (spec 049
 * FR-017): either answer is kept, and Settings keeps it changeable.
 *
 * Per account and outside the `imani-wallet:` prefix, so logging out and back in does not ask again,
 * exactly as `imani-receipts-ack:` is kept. A choice made in Settings is recorded here too, so the
 * prompt never asks about something the owner already decided there.
 */
import { fleetController } from './fleet/app'
import { enableNotifications, readStatus } from './notifications/manager'

export type FirstRunQuestion = 'notifications' | 'health'

export const FIRST_RUN_PREFIX = 'imani-first-run:'
export const firstRunKey = (question: FirstRunQuestion, pubkey: string) => `${FIRST_RUN_PREFIX}${question}:${pubkey}`

const listeners = new Set<() => void>()

/** The recorded answer, or null when never asked (or storage is unreadable). */
export function firstRunAnswer(question: FirstRunQuestion, pubkey: string, store: Storage = localStorage): boolean | null {
  try {
    const v = store.getItem(firstRunKey(question, pubkey))
    return v === 'yes' ? true : v === 'no' ? false : null
  } catch {
    return null
  }
}

/** Records an answer and tells the prompt, so it goes away wherever the answer came from. */
export function recordFirstRunAnswer(question: FirstRunQuestion, pubkey: string, yes: boolean, store: Storage = localStorage): void {
  try {
    store.setItem(firstRunKey(question, pubkey), yes ? 'yes' : 'no')
  } catch {
    // Private mode: asked again next time, which is the honest fallback.
  }
  for (const l of listeners) l()
}

export function onFirstRunAnswered(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** What the prompt needs from the app, injected by tests. */
export interface FirstRunPorts {
  /** Whether asking about notifications could change anything here. */
  notificationsAskable: () => Promise<boolean>
  /** Turns notifications on; the reason when it did not work. */
  enableNotifications: () => Promise<{ ok: boolean; reason: string | null }>
  /** Whether asking about health checks could change anything here. */
  healthAskable: () => Promise<boolean>
  enableHealth: () => Promise<void>
}

export function appFirstRunPorts(pubkey: string, stall: boolean): FirstRunPorts {
  const fleet = () => fleetController(pubkey, stall)
  return {
    // Not when it is on already, blocked (a browser will not ask twice) or impossible on this device.
    notificationsAskable: async () => {
      const s = await readStatus(pubkey)
      return s.availability.usable && s.permission !== 'denied' && s.permission !== 'unsupported' && !(s.subscribed && s.preferences.enabled)
    },
    enableNotifications: async () => {
      const r = await enableNotifications(pubkey)
      return { ok: r.ok, reason: r.reason }
    },
    // Not when this service does not offer it, or the owner already opted in.
    healthAskable: async () => (await fleet().available()) && !fleet().status().optedIn,
    enableHealth: () => fleet().optIn(),
  }
}
