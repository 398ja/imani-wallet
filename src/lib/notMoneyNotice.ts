import { toast } from 'sonner'
import { nip19 } from 'nostr-tools'

import { recordNotification } from './notifications/inbox'
import { loadProfile, profileName, refreshProfile, type Profile } from './profile'
import { terminalCredentialFromToken } from './notMoney'
import { TERMINAL_ROLE_LABELS } from './terminalRole'
import type { NotMoneyNoticeType } from './notifications/types'

/**
 * What a wallet says when a terminal credential, a renewal of one, or a licence reaches it
 * (#160, owner report on wallet 0.19.0: "Payment received" for a 1-sat credential).
 *
 * None of these is money, so none gets the money toast, the "+1 sat" or the `voucher_received`
 * bell row. Each has its own type and wording, names who sent it, and links to where it is used:
 *
 *   - a credential: "Terminal setup request from <stall>", to `/terminal/setup`;
 *   - a renewal:    "Terminal renewal from <stall>", to `/terminal/setup`;
 *   - a licence:    "Licence from <seller>", to `/settings/subscription`.
 *
 * ## Classified from signed bytes only
 *
 * The stall, terminal name and role are read from the credential's VERIFIED signed metadata
 * (`terminalCredentialFromToken`), never from the DM envelope, which its sender writes. A DM that
 * merely claims to be a credential gets no notice at all here.
 */

export type { NotMoneyNoticeType }
export const TERMINAL_SETUP_NOTICE: NotMoneyNoticeType = 'terminal_setup_request'
export const TERMINAL_RENEWAL_NOTICE: NotMoneyNoticeType = 'terminal_renewal'
export const LICENCE_NOTICE: NotMoneyNoticeType = 'licence_received'

/** What the bell and the toast say. */
export interface NotMoneyNotice {
  id: string
  type: NotMoneyNoticeType
  title: string
  body: string
  url: string
}

/** A pubkey's display name: its kind-0 name or NIP-05 handle, else a short npub. */
export function nameOf(pubkey: string, profile: Profile | null = loadProfile(pubkey)): string {
  if (profile && (profile.displayName || profile.nip05)) return profileName(profile)
  try {
    return `${nip19.npubEncode(pubkey).slice(0, 12)}…`
  } catch {
    return `${pubkey.slice(0, 8)}…`
  }
}

/**
 * The notice for a credential or renewal DM, or null when the DM is not one.
 *
 * @param content the DM rumor content
 * @param stallName the stall's display name, already resolved
 */
export function terminalNotice(content: string, stallName?: string): NotMoneyNotice | null {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
  if (m?.type !== 'imani-terminal-credential/1' || typeof m.token !== 'string') return null
  const signed = terminalCredentialFromToken(m.token)
  if (!signed) return null

  const renewal = typeof m.renews === 'string'
  const from = stallName ?? nameOf(signed.stall_pubkey)
  const role = TERMINAL_ROLE_LABELS[signed.role].name
  const terminal = signed.name ?? 'A terminal'
  const voucherId = typeof m.voucher_id === 'string' ? m.voucher_id : ''
  return renewal
    ? {
        id: `terminal-renewal:${voucherId}`,
        type: TERMINAL_RENEWAL_NOTICE,
        title: `Terminal renewal from ${from}`,
        body: `${terminal} (${role}). Not a payment: it renews a till's authority.`,
        url: '/terminal/setup',
      }
    : {
        id: `terminal-setup:${voucherId}`,
        type: TERMINAL_SETUP_NOTICE,
        title: `Terminal setup request from ${from}`,
        body:
          `${terminal} (${role}). Not a payment. A terminal needs its own device with no ` +
          'account: set it up from "Set this device up as a terminal" on a fresh device.',
        url: '/terminal/setup',
      }
}

/** The notice for a licence arriving, from its signed seller id. */
export function licenceNotice(voucherId: string, sellerPubkey: string | undefined, sellerName?: string): NotMoneyNotice {
  const from = sellerName ?? (sellerPubkey ? nameOf(sellerPubkey) : 'Imani')
  return {
    id: `licence:${voucherId}`,
    type: LICENCE_NOTICE,
    title: `Licence from ${from}`,
    body: 'Your subscription licence arrived. It is not part of your balance.',
    url: '/settings/subscription',
  }
}

/**
 * Show a notice: a plain toast (no money styling, no amount) and a bell row. Never throws.
 *
 * `recipientPubkey` scopes the bell row; without it only the toast shows.
 */
export function showNotice(notice: NotMoneyNotice, recipientPubkey?: string): void {
  try {
    toast(notice.title, { id: notice.id, description: notice.body, duration: 8000 })
    if (recipientPubkey) recordNotification(recipientPubkey, notice)
  } catch (e) {
    console.warn('[notice] could not show a notice:', e)
  }
}

/** Announced already, so a redelivered DM is one notice. */
const shown = new Set<string>()

/**
 * Announce a credential or renewal DM that reached THIS wallet. Never throws.
 *
 * Looks the stall's name up first (kind-0 or NIP-05), falling back to a short npub.
 */
export async function announceTerminalDm(content: string, recipientPubkey?: string): Promise<boolean> {
  try {
    const first = terminalNotice(content)
    if (!first || shown.has(first.id)) return false
    shown.add(first.id)
    const signed = terminalCredentialFromToken((JSON.parse(content) as { token: string }).token)!
    const profile = await refreshProfile(signed.stall_pubkey).catch(() => null)
    showNotice(terminalNotice(content, nameOf(signed.stall_pubkey, profile)) ?? first, recipientPubkey)
    return true
  } catch {
    return false
  }
}

/** Test seam. */
export function resetNotices(): void {
  shown.clear()
}
