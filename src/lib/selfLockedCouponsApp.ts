/**
 * The app's side of `selfLockedCoupons.ts` (#402): find coupon rows holding proofs locked to this
 * wallet's own key (a bearer split's change) and turn them back into ordinary coupons, so every other
 * door (an ordinary send, gateway-core's split) can spend them.
 *
 * Skips any row held by an outstanding checkout code or an unconfirmed send: those are spoken for.
 * Never throws. One pass at a time.
 */
import { getSigner } from './nap'
import { getWallet, listVouchers, notifyWalletChanged } from './wallet'
import { appCashlinkPorts } from './cashlinkPorts'
import { xOnlyPub } from './cashlinkLock'
import { hasSelfLockedProof, unlockSelfLockedRow, type SelfLockPorts } from './selfLockedCoupons'
import { tokenIdFrom } from '../../packages/wallet-storage/src/tokenId'
import { creditableFaceValue, parseVoucherToken } from './voucherToken'
import { withoutInFlight } from './pay'

function ports(): SelfLockPorts {
  return {
    ...appCashlinkPorts(),
    identitySecret: () => {
      try {
        return getSigner().withPrivkey((key) => Uint8Array.from(key))
      } catch {
        return null
      }
    },
  }
}

let running: Promise<number> | null = null

/** Unlock every self-locked coupon row; returns how many rows were rewritten. */
export function unlockSelfLockedCouponsNow(pubkey: string): Promise<number> {
  running ??= sweep(pubkey)
    .catch(() => 0)
    .finally(() => {
      running = null
    })
  return running
}

async function sweep(pubkey: string): Promise<number> {
  const p = ports()
  const K = p.identitySecret()
  if (!K) return 0
  let selfPub: string
  try {
    selfPub = xOnlyPub(K)
  } finally {
    K.fill(0)
  }
  const wallet = getWallet()
  let rewritten = 0
  // Rows held by an outstanding checkout code or an unconfirmed send are spoken for: the same filter
  // the send screen applies (`withoutInFlight`).
  for (const row of withoutInFlight(await listVouchers(), pubkey)) {
    if (!row.token) continue
    const status = String(row.status ?? '').toLowerCase()
    if (status === 'spent' || status === 'redeemed') continue
    if (!hasSelfLockedProof(row.token, selfPub)) continue
    const out = await unlockSelfLockedRow(p, { tokenId: row.token_id, token: row.token })
    if (out.kind !== 'unlocked') continue
    // The new rows first, then the old one: a page that dies in between leaves a duplicate the next
    // pass finds spent (its proofs are burnt), never a loss.
    for (const token of out.tokens) {
      const id = await tokenIdFrom(token)
      if (await wallet.getVoucher(id)) continue
      const parsed = parseVoucherToken(token)
      await wallet.saveVoucher({
        ...row,
        token_id: id,
        voucher_id: parsed.voucher.voucherId,
        token,
        amount: parsed.tokenAmount,
        token_amount: parsed.tokenAmount,
        face_value: creditableFaceValue(parsed).faceValue,
        status: 'active',
        updated_at: new Date().toISOString(),
      } as Parameters<typeof wallet.saveVoucher>[0])
    }
    const keptOldRow = out.tokens.length === 1 && (await tokenIdFrom(out.tokens[0])) === row.token_id
    if (!keptOldRow) await wallet.removeVoucher(row.token_id)
    rewritten += 1
  }
  if (rewritten) notifyWalletChanged()
  return rewritten
}
