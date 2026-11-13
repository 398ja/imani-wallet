/**
 * The app's side of the Cashlink ports (#295 phase 4): the real mint, the real gateway, the gift
 * wrap onto a link, and keeping a coupon in this wallet. `cashlinkFlow.ts` takes these injected, so
 * its tests drive every failure; this module is the one place they meet the browser.
 */
import type { VoucherRow } from '@imani/wallet-storage'

import { httpCashlinkGateway, httpCashlinkMint, wrapForLink, type CashlinkPorts, type KeptCoupon } from './cashlinkFlow'
import { fetchGiftWraps, giftTokensFrom } from './giftLink'
import { mirrorToGateway } from './transferSignature'
import { publish } from './relay'
import { getSigner } from './nap'
import { parseVoucherToken, creditableFaceValue } from './voucherToken'
import { SWAPPED_TO_SATS_STATUS } from './swapBack'
import { getWallet, notifyWalletChanged } from './wallet'
import { tokenIdFrom } from '../../packages/wallet-storage/src/tokenId'
import { cashlinkMovingKey } from './inFlightMoney'
import { buildReceivedTransaction, CASHLINK_TAKEN_BACK_MEMO } from './transactions'
import { cashbackValidation } from './cashbackValidation'

/** Put the locked gift on its link, then read it back: delivered only once a copy is found there. */
async function deliver(linkSecret: Uint8Array, token: string): Promise<boolean> {
  let me: string | undefined
  try {
    me = getSigner().pubkey?.toLowerCase()
  } catch {
    me = undefined
  }
  const wrap = wrapForLink(linkSecret, token, me)
  const [relayed, mirrored] = await Promise.all([
    publish(wrap).then((r) => r.ok > 0, () => false),
    mirrorToGateway(wrap),
  ])
  if (!relayed && !mirrored) return false
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const found = await giftTokensFrom(linkSecret, await fetchGiftWraps(linkSecret))
      if (found.some((t) => t.token === token)) return true
    } catch {
      // Read again.
    }
    await new Promise((r) => setTimeout(r, 1200))
  }
  return false
}

/**
 * A coupon this wallet now holds, as a voucher row (backed up by the wrapped writer like every
 * other). When only its sats came back, the row keeps the coupon's token for its history and the
 * value in `sats_token`, exactly as "Swap back to sats" does, so logout's backup check sees it.
 */
async function keep(coupon: KeptCoupon): Promise<void> {
  const parsed = parseVoucherToken(coupon.token)
  const now = new Date().toISOString()
  const row: VoucherRow = {
    token_id: await tokenIdFrom(coupon.token),
    voucher_id: parsed.voucher.voucherId,
    token: coupon.token,
    amount: parsed.tokenAmount,
    token_amount: parsed.tokenAmount,
    // #384: the proof's share of its gift (largest remainder), so a split gift sums to its face.
    face_value: coupon.faceValue ?? creditableFaceValue(parsed).faceValue,
    face_unit: parsed.voucher.unit,
    face_decimals: parsed.voucher.faceDecimals,
    backing_strategy: parsed.voucher.backingStrategy,
    issuer_id: (/^[0-9a-f]{64}$/i.test(parsed.voucher.issuerId) ? parsed.voucher.issuerId : parsed.voucher.issuerPublicKey).toLowerCase(),
    ...(parsed.voucher.expiresAt ? { expires_at: parsed.voucher.expiresAt } : {}),
    status: coupon.satsToken ? SWAPPED_TO_SATS_STATUS : 'active',
    ...(coupon.satsToken ? { sats_token: coupon.satsToken, sats_amount: coupon.sats } : {}),
    source_transport: coupon.why === 'claimed' ? 'gift_link' : 'gift_link_reclaim',
    created_at: now,
    updated_at: now,
  } as unknown as VoucherRow
  const wallet = getWallet()
  await wallet.saveVoucher(row)
  // A claim is a receive and needs its History row. The legacy receive gets one from
  // TokenRedemption's atomic write; this path never ran it, so a claimed Cashlink left the coupon
  // in the wallet and nothing in History. A Cashlink take-back gets its own incoming row too
  // (staging, 2026-11-05: the sent row's "Taken back" alone left the returned value unexplained in
  // History, and the owner saw no record of it). A failed row write never undoes the kept coupon.
  if (coupon.why === 'claimed' || coupon.takenBack) {
    try {
      await wallet.addTransaction(coupon.why === 'claimed' ? claimedRow(row, coupon.token, Date.now(), coupon.bundleId) : takenBackRow(row, coupon.token, Date.now(), coupon.bundleId))
    } catch (error) {
      console.warn('[cashlink] coupon kept but its History row was not written', error instanceof Error ? error.message : 'unknown')
    }
  }
  notifyWalletChanged()
}

/** The History row for a claimed coupon, from the voucher row just saved. Exported for tests. */
export function claimedRow(row: VoucherRow, token: string, at = Date.now(), bundleId?: string) {
  const r = row as unknown as Record<string, unknown>
  return buildReceivedTransaction({
    tokenId: String(r.token_id),
    amount: Number(r.face_value ?? r.token_amount ?? 0),
    unit: String(r.face_unit ?? 'UNKNOWN'),
    decimals: typeof r.face_decimals === 'number' ? r.face_decimals : 2,
    merchantId: typeof r.issuer_id === 'string' ? r.issuer_id : undefined,
    voucherId: typeof r.voucher_id === 'string' ? r.voucher_id : undefined,
    validation: cashbackValidation(token),
    bundleId,
    at,
  })
}

/**
 * The History row for a Cashlink coupon back with its issuer. Its own id (`returned:`), so it never
 * merges over the claim row of the same coupon on a wallet that both sent and claimed it.
 */
export function takenBackRow(row: VoucherRow, token: string, at = Date.now(), bundleId?: string) {
  const received = claimedRow(row, token, at, bundleId) as unknown as Record<string, unknown>
  const id = `returned:${String((row as unknown as Record<string, unknown>).token_id)}`
  return { ...received, id, txId: id, memo: CASHLINK_TAKEN_BACK_MEMO } as unknown as ReturnType<typeof claimedRow>
}

export function appCashlinkPorts(): CashlinkPorts {
  return {
    mint: httpCashlinkMint(),
    gateway: httpCashlinkGateway(),
    deliver,
    keep,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  }
}

// --- The "value is moving" ledger (logout) ----------------------------------

/**
 * The sender's links whose value is moving: being locked, or off the link and not yet back as a
 * voucher. Only the link's row id is kept (never a secret): logout refuses while any is listed,
 * because the link record alone does not say the value is safe until this wallet has run once more.
 */
function readMoving(pubkey: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(cashlinkMovingKey(pubkey)) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Throws when it cannot be written: nothing may move until it can. */
export function markMoving(pubkey: string, id: string): void {
  const now = readMoving(pubkey)
  if (!now.includes(id)) localStorage.setItem(cashlinkMovingKey(pubkey), JSON.stringify([...now, id]))
}

export function clearMoving(pubkey: string, id: string): void {
  try {
    const left = readMoving(pubkey).filter((v) => v !== id)
    if (left.length === 0) localStorage.removeItem(cashlinkMovingKey(pubkey))
    else localStorage.setItem(cashlinkMovingKey(pubkey), JSON.stringify(left))
  } catch {
    // Left listed: logout stays off, which keeps the value. The next run clears it.
  }
}
