import type { EventTemplate, Event } from 'nostr-tools'

import { getSigner } from './nap'
import { allAddressable, publish } from './relay'
import { getWallet, notifyWalletChanged } from './wallet'
import { buildIssueTransaction, toTransaction, type WalletTransaction } from './transactions'
import { MERCHANT_KIND } from './merchant'

/**
 * The merchant's books, backed by their key instead of their browser.
 *
 * Every coupon a merchant issues used to exist in exactly one place — that
 * device's IndexedDB. Nothing else had it: not the relay, and not
 * gateway-portal, whose voucher list cannot see Sell-flow coupons at all
 * (§15.9). A new phone, a cleared browser, or the logout that now wipes the
 * device meant every sale ever made was gone, and Stats reset to zero.
 *
 * So each issuance is also published as an addressable kind-30078 event,
 * `d=imani:issued:<voucherId>`, the same kind and shape as the merchant record —
 * one event per coupon rather than one per user, which is what makes each
 * replaceable on its own and restorable as a set.
 *
 * ENCRYPTED, unlike the merchant record. A stall's categories are public by
 * design; its takings are not. The content is NIP-44 sealed to the merchant's
 * OWN key, so the relay stores an opaque blob and only the key that issued the
 * coupons can read them back. That is also what makes the key the whole backup:
 * hold the nsec, recover the books.
 *
 * What is deliberately NOT in here: the Cashu token. That is bearer value, and
 * writing it to a relay — even encrypted — would put spendable money somewhere
 * it does not need to be. These records are a ledger, not a wallet.
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

/** Exported for tests: the unit conversion below is the easy thing to get wrong. */
export function toRecord(tx: WalletTransaction): IssuedRecord | null {
  if (!tx.voucherId) return null
  return {
    voucherId: tx.voucherId,
    amount: tx.amount,
    unit: tx.unit,
    decimals: tx.decimals,
    recipientPubkey: tx.counterparty ?? '',
    memo: tx.memo,
    // Back to seconds: `toTransaction` normalised it to ms on the way in, and
    // the wire format is seconds everywhere else in this app.
    expiresAt: tx.expiresAt === undefined ? undefined : Math.floor(tx.expiresAt / 1000),
    at: tx.at,
  }
}

/** The event for one issuance. Encrypted to self; throws if the wallet is locked. */
export function buildIssuedEvent(tx: WalletTransaction): EventTemplate | null {
  const record = toRecord(tx)
  if (!record) return null

  const signer = getSigner()
  return {
    kind: MERCHANT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', `${ISSUED_D_PREFIX}${record.voucherId}`]],
    content: signer.nip44Encrypt(signer.pubkey, JSON.stringify(record)),
  }
}

/**
 * Publish one issuance record.
 *
 * Never throws. A relay that will not take the record has not undone the sale —
 * the coupon is with the customer and the row is already in IndexedDB — so this
 * is reported and not fatal, exactly as the kind-0 publish is during
 * registration. The cost of failure is that this one sale is missing if the
 * device is later wiped, which is worth a console line and not a failed sale.
 */
export async function publishIssued(tx: WalletTransaction): Promise<void> {
  try {
    const template = buildIssuedEvent(tx)
    if (!template) return
    await publish(await getSigner().signEvent(template))
  } catch (error) {
    console.error('[issuedRecords] sale not backed up to the relay', error)
  }
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

/**
 * Back-fill records for sales made before this existed, or while a relay was
 * down. Publishes only what the relay is missing.
 *
 * Cheap to call on login — it costs one query, and it closes the gap for every
 * merchant whose earlier sales predate this feature.
 */
export async function backfillIssued(pubkey: string): Promise<number> {
  try {
    const events = await allAddressable(pubkey, MERCHANT_KIND, ISSUED_D_PREFIX)
    const known = new Set(
      events
        .map((e) => e.tags.find(([name]) => name === 'd')?.[1])
        .filter((d): d is string => Boolean(d))
        .map((d) => d.slice(ISSUED_D_PREFIX.length)),
    )

    const rows = (await getWallet().getAllTransactions()).map(toTransaction)
    const missing = rows.filter(
      (tx) => tx.type === 'issued' && tx.voucherId && !known.has(tx.voucherId),
    )

    for (const tx of missing) await publishIssued(tx)
    return missing.length
  } catch (error) {
    console.error('[issuedRecords] could not back-fill sales to the relay', error)
    return 0
  }
}
