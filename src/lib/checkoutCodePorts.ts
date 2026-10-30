/**
 * The app's side of the checkout-code ports (#402): the Cashlink ports, the code store, the
 * session key, and the wallet's own coupon rows. `checkoutCodeFlow.ts` takes these injected so its
 * tests drive every failure; this module is the one place they meet the browser.
 */
import { appCashlinkPorts } from './cashlinkPorts'
import { nip98Header } from './nip98'
import { getSigner } from './nap'
import { getWallet, notifyWalletChanged } from './wallet'
import { faceSharesOf } from './faceSplit'
import { replaceVoucherToken } from './pay'
import { tokenProofs, parseVoucherToken } from './voucherToken'
import { encodePlainTokenV4 } from './plainToken'
import type { CheckoutPorts, CheckoutStore } from './checkoutCodeFlow'

/** Build-time switch: the feature ships dark until `VITE_CHECKOUT_CODES=on`. */
export function checkoutCodesEnabled(raw: unknown = import.meta.env.VITE_CHECKOUT_CODES): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'on'
}

const STORE_TIMEOUT_MS = 15_000

/** The code store, NIP-98 signed by the session (the customer). Same origin, proxied like the gateway. */
export function httpCheckoutStore(): CheckoutStore {
  return {
    async call(method, path, body) {
      const text = body === undefined ? undefined : JSON.stringify(body)
      const r = await fetch(path, {
        method,
        headers: { Authorization: await nip98Header(path, method, text), ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: text,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
      })
      return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null }
    },
  }
}

/**
 * The proofs of a coupon whose face shares add up to exactly `amount`, largest first. A coupon's
 * proofs are powers of two of sats under one voucher secret each, so a part can be carved without a
 * mint call by taking some of them whole. Null when no subset makes the amount.
 */
export function carveProofs(token: string, amount: number): { part: string; rest: string | null } | null {
  const shares = faceSharesOf(token)
  if (!shares) return null
  const mintUrl = parseVoucherToken(token).mintUrl
  const proofs = tokenProofs(token).sort((a, b) => (shares.get(b.secret) ?? 0) - (shares.get(a.secret) ?? 0))
  const pick = (from: number, left: number): number[] | null => {
    if (left === 0) return []
    for (let n = from; n < proofs.length; n++) {
      const share = shares.get(proofs[n].secret) ?? 0
      if (share > 0 && share <= left) {
        const more = pick(n + 1, left - share)
        if (more) return [n, ...more]
      }
    }
    return null
  }
  const chosen = pick(0, amount)
  if (!chosen || chosen.length === 0) return null
  const plain = (ps: typeof proofs) => encodePlainTokenV4(mintUrl, 'sat', ps.map((p) => ({ amount: p.amount, id: p.id, secret: p.secret, C: p.C, ...(p.dleq ? { dleq: p.dleq } : {}) })))
  const taken = new Set(chosen)
  const rest = proofs.filter((_, n) => !taken.has(n))
  return { part: plain(proofs.filter((_, n) => taken.has(n))), rest: rest.length ? plain(rest) : null }
}

export function appCheckoutPorts(): CheckoutPorts {
  return {
    ...appCashlinkPorts(),
    store: httpCheckoutStore(),
    identitySecret: () => {
      try {
        return getSigner().withPrivkey((key) => Uint8Array.from(key))
      } catch {
        return null
      }
    },
    async carve(tokenId, amount) {
      const row = await getWallet().getVoucher(tokenId)
      if (!row) throw new Error('that coupon is no longer in this wallet')
      const carved = carveProofs(row.token, amount)
      if (!carved) throw new Error('this amount cannot be taken from that coupon')
      // The rest stays a coupon of its own. The part is held by the code record already (the whole
      // source row is held while the code is outstanding), so nothing can spend either twice.
      if (carved.rest) await replaceVoucherToken(getWallet(), tokenId, carved.rest)
      else await getWallet().removeVoucher(tokenId)
      notifyWalletChanged()
      return carved.part
    },
    async consume(tokenId) {
      await getWallet().removeVoucher(tokenId)
      notifyWalletChanged()
    },
    async activity(row) {
      await getWallet().addTransaction({
        id: row.id,
        txId: row.id,
        type: 'checkout_code',
        direction: 'out',
        timestamp: row.at,
        amount: row.amount,
        unit: row.unit,
        decimals: row.decimals,
        merchantId: row.stall,
        memo: row.memo,
      } as unknown as Parameters<ReturnType<typeof getWallet>['addTransaction']>[0])
    },
  }
}
