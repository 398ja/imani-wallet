/**
 * What the seller last said about each subscription's renewal, per account (#407).
 *
 * Written when a seller-sealed `imani-subscription-status/1` DM arrives (dmCrypto.ts), read by
 * Settings › Subscription to say "Cancelled, ends <date>" instead of a bare "Active". Keyed by
 * subscription id, newest `at` wins, so a replayed older message never undoes a newer one.
 *
 * Display only, like the message: nothing here grants or refuses anything (ADR 0007).
 */
import { parseSubscriptionStatus, type SubscriptionStatusMessage } from './subscriptionStatus'

const KEY_PREFIX = 'imani.subscription.status.'
/** A backstop: a stall holds a handful of subscriptions in its life. */
const MAX_ENTRIES = 64
export const SUBSCRIPTION_STATUS_EVENT = 'imani:subscription-status'

const keyFor = (pubkey: string) => `${KEY_PREFIX}${pubkey.trim().toLowerCase()}`

export function readSubscriptionStatuses(pubkey: string): Record<string, SubscriptionStatusMessage> {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(pubkey)) ?? '{}') as Record<string, unknown>
    const out: Record<string, SubscriptionStatusMessage> = {}
    for (const v of Object.values(raw ?? {})) {
      // Re-read through the strict parser, so a hand-edited entry is dropped rather than trusted.
      const m = typeof v === 'string' ? parseSubscriptionStatus(v) : null
      if (m) out[m.subscriptionId] = m
    }
    return out
  } catch {
    return {}
  }
}

/** The seller's latest word on this subscription, or null. */
export function subscriptionStatusFor(pubkey: string, subscriptionId: string | undefined): SubscriptionStatusMessage | null {
  if (!subscriptionId) return null
  return readSubscriptionStatuses(pubkey)[subscriptionId] ?? null
}

/**
 * Keep `content` (the DM, already checked to be sealed by the pinned seller) when it is newer than
 * what this account holds. Returns whether anything changed.
 */
export function rememberSubscriptionStatus(pubkey: string, content: string): boolean {
  const m = parseSubscriptionStatus(content)
  if (!m) return false
  let stored: Record<string, string>
  try {
    stored = JSON.parse(localStorage.getItem(keyFor(pubkey)) ?? '{}') as Record<string, string>
  } catch {
    stored = {}
  }
  const held = typeof stored[m.subscriptionId] === 'string' ? parseSubscriptionStatus(stored[m.subscriptionId]) : null
  if (held && held.at >= m.at) return false
  stored[m.subscriptionId] = content
  const ids = Object.keys(stored)
  if (ids.length > MAX_ENTRIES) {
    const byAge = ids
      .map((id) => ({ id, at: parseSubscriptionStatus(stored[id])?.at ?? 0 }))
      .sort((a, b) => a.at - b.at)
    for (const { id } of byAge.slice(0, ids.length - MAX_ENTRIES)) delete stored[id]
  }
  try {
    localStorage.setItem(keyFor(pubkey), JSON.stringify(stored))
  } catch {
    return false
  }
  try {
    window.dispatchEvent(new CustomEvent(SUBSCRIPTION_STATUS_EVENT, { detail: { subscriptionId: m.subscriptionId } }))
  } catch {
    /* not in a browser (tests): the store is still written */
  }
  return true
}
