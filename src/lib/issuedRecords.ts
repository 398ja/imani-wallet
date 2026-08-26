import type { Event } from 'nostr-tools'

import { getSigner } from './nap'
import { allAddressable } from './relay'
import { getWallet, notifyWalletChanged } from './wallet'
import { buildIssueTransaction } from './transactions'
import { MERCHANT_KIND } from './merchant'

/**
 * READ-ONLY, AND TEMPORARY: the old sale-only backup.
 *
 * This published one addressable kind-30078 event per sale,
 * `d=imani:issued:<voucherId>`, NIP-44 sealed to the merchant's own key. It was
 * right about the mechanism and wrong about the scope — it backed up sales and
 * nothing else, so a merchant who logged out lost every redemption. `txRecords`
 * replaced it with one NIP-60 record per row, whichever way the money went, and
 * owns the writing now.
 *
 * What is left here is the reader, for the records already on the relay. Note
 * that `restoreIssued` writes through the wrapped `addTransaction`, so a sale
 * restored from an old record is immediately republished in the new shape —
 * which is what makes this safe to delete a release from now.
 */

export const ISSUED_D_PREFIX = 'imani:issued:'

/** The fields worth keeping. A subset of the transaction row, minus anything derivable. */
interface IssuedRecord {
  voucherId: string
  amount: number
  unit: string
  decimals: number
  recipientPubkey: string
  memo?: string
  /** Epoch SECONDS, as everything on the wire uses. */
  expiresAt?: number
  /** When the sale happened, epoch MILLISECONDS. */
  at: number
}

/** Decrypt one event back into a record. Returns null for anything unreadable. */
function parseIssued(event: Event): IssuedRecord | null {
  try {
    const signer = getSigner()
    const parsed = JSON.parse(signer.nip44Decrypt(signer.pubkey, event.content)) as IssuedRecord
    return typeof parsed?.voucherId === 'string' ? parsed : null
  } catch {
    // Written by another key, or by a future version that changed the shape.
    // One unreadable record must not abort the restore of all the others.
    return null
  }
}

/**
 * Rebuild the issuance history from the relay into this device's wallet.
 *
 * Runs on every login, not only on an empty wallet: a merchant who sold on
 * another device should see those sales here too, and `addTransaction` is keyed
 * on the row id (`issued:<voucherId>`), so re-writing a row this device already
 * has is an overwrite rather than a duplicate.
 *
 * Never throws — an unreachable relay leaves whatever the device already had,
 * which is the same contract `refreshProfile` and `refreshMerchant` follow.
 * Returns how many rows were written, for the caller to log.
 */
export async function restoreIssued(pubkey: string): Promise<number> {
  try {
    const events = await allAddressable(pubkey, MERCHANT_KIND, ISSUED_D_PREFIX)
    if (events.length === 0) return 0

    const wallet = getWallet()
    let restored = 0

    for (const event of events) {
      const record = parseIssued(event)
      if (!record) continue
      await wallet.addTransaction(
        buildIssueTransaction({
          voucherId: record.voucherId,
          amount: record.amount,
          unit: record.unit,
          decimals: record.decimals,
          recipientPubkey: record.recipientPubkey,
          memo: record.memo,
          expiresAt: record.expiresAt,
          at: record.at,
        }),
      )
      restored += 1
    }

    if (restored > 0) notifyWalletChanged()
    return restored
  } catch (error) {
    console.error('[issuedRecords] could not restore sales from the relay', error)
    return 0
  }
}
