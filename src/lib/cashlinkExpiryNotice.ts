/**
 * "Your Cashlink expired" in the bell (#295 phase 0).
 *
 * A customer's Cashlink that nobody claims comes back only when the sender's wallet runs: the take
 * back is a receive, and only this wallet can sign it (ADR 0001). So when a link passes its expiry
 * the sender is told, in plain words, once:
 *
 * - still waiting on the link (the take-back could not run yet): "Your Cashlink expired. Open Imani
 *   to take it back." Tapping it opens the send, whose section takes it back.
 * - already taken back by the wallet's own check: "Your Cashlink expired, so its voucher came back
 *   to you."
 *
 * ## Customer Cashlinks only
 *
 * Owner scope, 2026-10-21: a STALL's Cashlink (Sell, or a till) that expires is not returned to the
 * stall, by design, so it gets no notice. Those are `cashback` rows with no `link` record and never
 * reach `linkRows()`. A merchant account is skipped as well: it cannot take another stall's coupon
 * back (owner rule 2026-10-13), so a link it made before opening a stall would be a notice it can
 * do nothing about.
 *
 * ## Once per link, and it survives a restore
 *
 * The bell id is `cashlink-expired:<row id>`, and the inbox refuses a repeated id. The inbox keeps
 * only 50 rows and lives in this device's storage, so the link's own record also gets `noticedAt`.
 * That record travels in the encrypted history backup, so a restored or second device sees it and
 * does not file the entry again. A local set of filed ids covers the moment between filing and the
 * record being written. Nothing here names the link's secret: the id is the row id.
 *
 * Never throws: it runs on start-up and on a timer, and a notice must never break a screen.
 */
import { distinctLinks, linkRows, markLinksNoticed, reconcileGiftLinks, type LinkRow } from './giftLinks'
import { loadMerchant } from './merchant'
import { recordNotification } from './notifications/inbox'

export const CASHLINK_EXPIRED_TITLE = 'Cashlink expired'
/** The owner's words (#295). No jargon: the noProtocolJargon guard reads it. */
export const CASHLINK_EXPIRED_WAITING_BODY = 'Your Cashlink expired. Open Imani to take it back.'
export const CASHLINK_EXPIRED_RETURNED_BODY = 'Your Cashlink expired, so its voucher came back to you.'

const FILED_KEY = (pubkey: string) => `imani-wallet:cashlink-expired:${pubkey}`
const MAX_FILED = 500
/** How recent a take-back must be to be announced (see `runCashlinkExpiryNotices`). */
export const RETURNED_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000

/** The bell id for a link: its first row's id. Never the link secret. */
export function cashlinkNoticeId(parts: LinkRow[]): string {
  return `cashlink-expired:${parts[0].id}`
}

function readFiled(pubkey: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FILED_KEY(pubkey)) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeFiled(pubkey: string, ids: string[]): void {
  try {
    localStorage.setItem(FILED_KEY(pubkey), JSON.stringify(ids.slice(-MAX_FILED)))
  } catch {
    // A private window: the record's `noticedAt` and the inbox's own id check still dedupe.
  }
}

/**
 * File the notices that are due. Returns how many were filed.
 *
 * Due: a link past its expiry that is still waiting, or that this wallet took back at or after its
 * expiry, and that has not been noticed before (on any device). A link claimed, or taken back by
 * hand (`takeBack` marks it noticed), is never announced.
 */
export async function runCashlinkExpiryNotices(pubkey: string, nowMs = Date.now()): Promise<number> {
  try {
    if (!pubkey || loadMerchant(pubkey) !== null) return 0
    const now = Math.floor(nowMs / 1000)
    const filed = readFiled(pubkey)
    const seen = new Set(filed)
    let added = 0
    for (const parts of distinctLinks(await linkRows()).values()) {
      const link = parts[0].link
      if (now < link.x) continue
      if (parts.some((p) => p.link.noticedAt !== undefined)) continue
      const waiting = parts.some((p) => p.link.status === 'outstanding')
      // Only a take-back that has just happened: links the wallet took back before this notice
      // existed must not all announce themselves on the first open after an update.
      const returned =
        !waiting &&
        parts.every(
          (p) =>
            p.link.status === 'reclaimed' &&
            (p.link.closedAt ?? 0) >= link.x * 1000 &&
            (p.link.closedAt ?? 0) >= nowMs - RETURNED_NOTICE_WINDOW_MS,
        )
      if (!waiting && !returned) continue
      const id = cashlinkNoticeId(parts)
      if (!seen.has(id)) {
        seen.add(id)
        filed.push(id)
        const isNew = recordNotification(pubkey, {
          id,
          type: 'cashlink_expired',
          title: CASHLINK_EXPIRED_TITLE,
          body: waiting ? CASHLINK_EXPIRED_WAITING_BODY : CASHLINK_EXPIRED_RETURNED_BODY,
          url: `/transaction/${encodeURIComponent(parts[0].id)}`,
          receivedAt: nowMs,
        })
        if (isNew) added += 1
      }
      await markLinksNoticed(parts, nowMs)
    }
    writeFiled(pubkey, filed)
    return added
  } catch (e) {
    console.warn('[cashlink] expiry notice pass failed:', e instanceof Error ? e.message : String(e))
    return 0
  }
}

/**
 * Accounts whose start-up reconcile has finished in this session. Until then the hourly pass stays
 * quiet: the reconcile is about to take expired links back, and "Open Imani to take it back" for a
 * link the open app is taking back that second would be wrong.
 */
const settled = new Set<string>()

/** Start-up's pass, after `reconcileGiftLinks` (App.tsx). Opens the gate for the hourly one. */
export async function runCashlinkExpiryNoticesAfterReconcile(pubkey: string, nowMs = Date.now()): Promise<number> {
  settled.add(pubkey)
  return runCashlinkExpiryNotices(pubkey, nowMs)
}

/**
 * The hourly and on-focus pass (`useExpiryReminders`). Nothing until start-up has settled. When a
 * link has expired since, it is taken back first (the app is open, so it can), and the notice then
 * says it came back rather than asking the sender to open the app they are using.
 */
export async function runCashlinkExpiryNoticesIfSettled(pubkey: string, nowMs = Date.now()): Promise<number> {
  if (!settled.has(pubkey)) return 0
  if (loadMerchant(pubkey) === null) {
    const now = Math.floor(nowMs / 1000)
    const due = [...distinctLinks(await linkRows().catch(() => [])).values()].some(
      // Review of #380: any row of the link (a 0.39.0 restore-scan duplicate may sort first with a
      // 30-day guess), so the hourly pass never waits past the send's own expiry.
      (parts) => parts.some((p) => now >= p.link.x) && parts.some((p) => p.link.status === 'outstanding'),
    )
    if (due) await reconcileGiftLinks(nowMs)
  }
  return runCashlinkExpiryNotices(pubkey, nowMs)
}
