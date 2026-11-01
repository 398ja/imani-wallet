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
import { tokenIdFrom } from '../../packages/wallet-storage/src/tokenId'
import { creditableFaceValue, parseVoucherToken } from './voucherToken'
import type { CheckoutPorts, CheckoutStore } from './checkoutCodeFlow'
import type { SplitPorts } from './voucherSplit'
import { loadCheckoutCodes, onCheckoutCodeSaved, type CheckoutCodeRecord } from './checkoutCodeRecords'
import { checkoutCodeRow, checkoutTxId, codeIdOfActivity } from './checkoutCodeHistory'

type TxRow = Parameters<ReturnType<typeof getWallet>['addTransaction']>[0]

let lastPubkey: string | undefined
const chains = new Map<string, Promise<void>>()

function findRecord(codeId: string): { pubkey: string; record: CheckoutCodeRecord } | undefined {
  if (!lastPubkey) return undefined
  try {
    const record = loadCheckoutCodes(lastPubkey).find((r) => r.id === codeId)
    return record ? { pubkey: lastPubkey, record } : undefined
  } catch {
    return undefined
  }
}

/**
 * Write (or rewrite) a code's one history row, through the wrapped writer so the relay gets it.
 * Writes per code are chained, so a fast run of saves lands in the order it was made. A memo
 * already on the row is kept unless a new one is given. Never throws: history is display.
 */
export function writeCodeRow(pubkey: string, record: CheckoutCodeRecord, memo?: string): Promise<void> {
  lastPubkey = pubkey
  const id = checkoutTxId(record.id)
  const next = (chains.get(id) ?? Promise.resolve()).then(async () => {
    try {
      const wallet = getWallet()
      const existing = (await wallet.getTransaction(id)) as unknown as Record<string, unknown> | null
      const kept = memo ?? (typeof existing?.memo === 'string' ? existing.memo : undefined)
      await wallet.addTransaction(checkoutCodeRow(record, kept) as unknown as TxRow)
      notifyWalletChanged()
    } catch {
      // No wallet open (tests, a locked session): the record is the authority either way.
    }
  })
  chains.set(id, next)
  return next
}

/** Every code save rewrites its history row (#402), wherever the save came from. */
onCheckoutCodeSaved((pubkey, record) => void writeCodeRow(pubkey, record))

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

/**
 * #402: a split voucher's new rows. Each part is its own coupon row with the source row's issuer,
 * unit, decimals and expiry (`replaceVoucherToken` keeps them, and its reminders), and the source row
 * becomes the remainder. Idempotent: rows already written for these tokens are left as they are, so a
 * run that died after this and runs again writes nothing twice.
 */
async function commitSplit(sourceTokenId: string, remainder: string | null, parts: string[]): Promise<{ partIds: string[]; remainderId: string | null }> {
  const wallet = getWallet()
  const source = await wallet.getVoucher(sourceTokenId)
  const partIds = await Promise.all(parts.map((t) => tokenIdFrom(t)))
  const remainderId = remainder ? await tokenIdFrom(remainder) : null
  for (const [n, token] of parts.entries()) {
    if (await wallet.getVoucher(partIds[n])) continue
    const parsed = parseVoucherToken(token)
    const now = new Date().toISOString()
    await wallet.saveVoucher({
      ...(source ?? {}),
      token_id: partIds[n],
      voucher_id: parsed.voucher.voucherId,
      token,
      amount: parsed.tokenAmount,
      token_amount: parsed.tokenAmount,
      face_value: creditableFaceValue(parsed).faceValue,
      face_unit: parsed.voucher.unit,
      face_decimals: parsed.voucher.faceDecimals,
      ...(parsed.voucher.expiresAt ? { expires_at: parsed.voucher.expiresAt } : {}),
      status: 'active',
      created_at: source?.created_at ?? now,
      updated_at: now,
    } as Parameters<typeof wallet.saveVoucher>[0])
  }
  if (source) {
    if (remainder) await replaceVoucherToken(wallet, sourceTokenId, remainder, creditableFaceValue(parseVoucherToken(remainder)).faceValue)
    else await wallet.removeVoucher(sourceTokenId)
  }
  notifyWalletChanged()
  return { partIds, remainderId }
}

export function appCheckoutPorts(): CheckoutPorts & SplitPorts {
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
      // Its face is restated to the rest token's own credit (what the store would credit it for), so
      // the balance never keeps showing what the code took (staging 2026-11-01: 5.19 shown, 5.10
      // usable online, the 9 c being the carved part).
      if (carved.rest) await replaceVoucherToken(getWallet(), tokenId, carved.rest, creditableFaceValue(parseVoucherToken(carved.rest)).faceValue)
      else await getWallet().removeVoucher(tokenId)
      notifyWalletChanged()
      return carved.part
    },
    async consume(tokenId) {
      await getWallet().removeVoucher(tokenId)
      notifyWalletChanged()
    },
    commit: commitSplit,
    async activity(row) {
      // One history row per code (#402): the outcome's words go on the code's own row as its memo,
      // never a second row, so the code is one movement in history, not two.
      const codeId = codeIdOfActivity(row.id)
      const record = codeId ? findRecord(codeId) : undefined
      if (record) await writeCodeRow(record.pubkey, record.record, row.memo)
    },
  }
}
