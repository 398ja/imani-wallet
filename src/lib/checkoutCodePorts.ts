/**
 * The app's side of the checkout-code ports (#402): the Cashlink ports, the code store, the
 * session key, and the wallet's own coupon rows. `checkoutCodeFlow.ts` takes these injected so its
 * tests drive every failure; this module is the one place they meet the browser.
 */
import { appCashlinkPorts } from './cashlinkPorts'
import { nip98Header } from './nip98'
import { getSigner } from './nap'
import { getWallet, notifyWalletChanged } from './wallet'
import { carveProofs } from './checkoutCarve'
import { replaceVoucherToken } from './pay'
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

export { carveProofs } from './checkoutCarve'

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
