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
import { parseVoucherToken, creditableFaceValue } from './voucherToken'
import { SWAPPED_TO_SATS_STATUS } from './swapBack'
import { getWallet, notifyWalletChanged } from './wallet'
import { tokenIdFrom } from '../../packages/wallet-storage/src/tokenId'
import { cashlinkMovingKey } from './inFlightMoney'

/** Put the locked gift on its link, then read it back: delivered only once a copy is found there. */
async function deliver(linkSecret: Uint8Array, token: string): Promise<boolean> {
  const wrap = wrapForLink(linkSecret, token)
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
  await getWallet().saveVoucher(row)
  notifyWalletChanged()
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
