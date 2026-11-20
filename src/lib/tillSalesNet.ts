import type { TransactionRow } from '@imani/wallet-storage'

import { getSigner } from './nap'
import { getWallet, notifyWalletChanged, recordCashAttestation } from './wallet'
import { retryPendingAttestations } from './pendingAttestations'
import { giftWraps, devicePublisher } from './terminalDeliveryNet'
import { unwrapSealed } from './terminalDelivery'
import { collectTillSales, flushSaleOutbox, sendTillSale, setTillSaleSink, type SealWith } from './tillSales'
import { fetchStallCardSales, pullCardSales, requestSaleResend } from './cardSalePull'

/**
 * The network half of till sales (#160 phase 6, wallet#202), kept apart from `tillSales.ts` so
 * that module's rules stay testable with no relay, gateway or wallet.
 */

/**
 * File the stall's till sales from its inbox (owner side). Never throws.
 *
 * Called from the login restore chain, from the Vouchers list, and when dm-poll opens a sale
 * record. Written through the wrapped `addTransaction`, so each row is republished as the owner's
 * own 7376 and survives this device.
 */
export async function collectTillSalesForOwner(stallPubkey: string): Promise<number> {
  try {
    const wallet = getWallet()
    const filed = await collectTillSales(stallPubkey, {
      wraps: giftWraps,
      open: (wrap) => getSigner().withPrivkey((key) => unwrapSealed(wrap, key)),
      has: async (id) => (await wallet.getTransaction(id)) != null,
      write: async (row: TransactionRow) => void (await wallet.addTransaction(row)),
    })
    if (filed > 0) {
      // A card sale's row often lands after the customer's receipt did (#655 follow-up): file the
      // attestations that were kept waiting for it.
      await retryPendingAttestations(stallPubkey, recordCashAttestation).catch(() => 0)
      notifyWalletChanged()
    }
    return filed
  } catch (error) {
    console.warn('[tillSales] could not collect till sales', error)
    return 0
  }
}

/** How often an open till retries its outbox. */
export const OUTBOX_RETRY_MS = 60_000

/**
 * Install the till's sale sink for an unlocked till, and send anything the outbox holds.
 *
 * @param signer the till's own NIP-98 signer (the installed signer), for the gateway mirror
 * @returns a function that uninstalls the sink and stops the retry timer
 */
export function openTillSales(
  stallPubkey: string,
  credentialVoucherId: string,
  sealWith: SealWith,
  signer: Parameters<typeof devicePublisher>[0],
): () => void {
  const publisher = devicePublisher(signer)
  setTillSaleSink((rows) => sendTillSale(rows, stallPubkey, credentialVoucherId, sealWith, publisher))
  const flush = () => void flushSaleOutbox(sealWith, publisher).catch(() => 0)
  flush()
  const timer = setInterval(flush, OUTBOX_RETRY_MS)
  return () => {
    clearInterval(timer)
    setTillSaleSink(null)
  }
}

/**
 * The pull on login for card sales (imani-wallet#275 item 3): list the stall's card sales from
 * payment-adapter, have the purchase issuer re-send any record this device lacks, file them, and
 * re-date a card row whose time disagrees with the recorded payment. Never throws.
 */
export async function pullCardSalesForOwner(stallPubkey: string): Promise<number> {
  try {
    const wallet = getWallet()
    const result = await pullCardSales(stallPubkey, {
      listSales: fetchStallCardSales,
      requestResend: requestSaleResend,
      collect: collectTillSalesForOwner,
      getRow: (id) => wallet.getTransaction(id),
      patchRow: async (id, patch) => void (await wallet.updateTransaction(id, patch as Partial<TransactionRow>)),
    })
    if (result.redated > 0) notifyWalletChanged()
    return result.filed
  } catch (error) {
    console.warn('[tillSales] could not pull card sales', error)
    return 0
  }
}
