import { buildMerchantEvent, loadMerchant, saveMerchant, type MerchantProfile } from './merchant'
import type { OnlineShop } from './onlineShop'
import type { TerminalRecord } from './terminalRoster'

/**
 * Keeping the stall's published `online_shop` (#402 §0, contract §4) in step with its roster.
 *
 * The same mechanism as `cardOffer.ts`: a kind-30078 is replaced wholesale, so connecting a shop
 * is a republish with the field and revoking it is a republish without. `buildMerchantEvent`
 * writes every other field from the stored record, so nothing else on the profile is dropped.
 *
 * The roster is the source of truth. A shop is advertised only while its terminal row is in
 * service and not revoked: a waiting row's shop has not confirmed it holds its credential, and a
 * revoked row's key must stop receiving locks at once (R5), which is why revoke ends here too.
 * One online shop per stall in v1: the most recently enrolled live one wins.
 */

/** The shop the roster says should be advertised, or null. */
export function advertisedShop(rows: readonly TerminalRecord[]): OnlineShop | null {
  const live = rows
    .filter((r) => r.shop && r.revokedAt === undefined && (r.status === undefined || r.status === 'in-service'))
    .sort((a, b) => b.enrolledAt - a.enrolledAt)
  const row = live[0]
  if (!row?.shop) return null
  return {
    url: row.shop.url,
    redeemKey: row.terminalPubkey.toLowerCase(),
    platform: row.shop.platform,
    since: Math.floor(row.enrolledAt / 1000),
  }
}

export type OnlineShopChange =
  | { kind: 'republish'; merchant: MerchantProfile }
  | { kind: 'unchanged' }

const same = (a: OnlineShop | undefined | null, b: OnlineShop | undefined | null) =>
  (!a && !b) ||
  (!!a && !!b && a.url === b.url && a.redeemKey === b.redeemKey && a.platform === b.platform && a.since === b.since)

/** What, if anything, to publish. Pure, like `reconcileCardOffer`. */
export function reconcileOnlineShop(merchant: MerchantProfile, rows: readonly TerminalRecord[]): OnlineShopChange {
  const want = advertisedShop(rows)
  if (same(merchant.onlineShop, want)) return { kind: 'unchanged' }
  const next: MerchantProfile = { ...merchant }
  if (want) next.onlineShop = want
  else delete next.onlineShop
  return { kind: 'republish', merchant: next }
}

export interface ProfilePublisher {
  sign(template: ReturnType<typeof buildMerchantEvent>): Promise<{ created_at: number } & Record<string, unknown>>
  publish(signed: unknown): Promise<{ ok: number }>
}

/**
 * Reconcile and, if needed, save and publish. Local first, as `PaymentsSettingsPage` does.
 *
 * @returns whether the profile changed, and whether a relay took it
 */
export async function syncOnlineShop(
  stallPubkey: string,
  rows: readonly TerminalRecord[],
  publisher: ProfilePublisher,
): Promise<{ changed: boolean; published: boolean }> {
  const merchant = loadMerchant(stallPubkey)
  if (!merchant) return { changed: false, published: false }
  const change = reconcileOnlineShop(merchant, rows)
  if (change.kind === 'unchanged') return { changed: false, published: false }
  saveMerchant(change.merchant)
  try {
    const signed = await publisher.sign(buildMerchantEvent(change.merchant))
    saveMerchant({ ...change.merchant, eventAt: signed.created_at })
    const { ok } = await publisher.publish(signed)
    return { changed: true, published: ok > 0 }
  } catch {
    return { changed: true, published: false }
  }
}
