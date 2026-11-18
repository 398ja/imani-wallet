/**
 * Filing a card sale into the stall's own ledger (imani-wallet#275, audit gap D).
 *
 * A till files its sales by sending the stall an `imani-terminal-sale/1` record, gift-wrapped
 * (NIP-17) and sealed by its own key (`src/lib/tillSales.ts`). A card sale had no such record:
 * in Stripe S1 the merchant page read "No record of this voucher" until a row was seeded by hand.
 *
 * This service sends the same record, sealed by the credential's lock key, which is the key the
 * stall delegated `coupon:issue` to. The row carries the coupon's `delegated` warrant with the
 * stall's own delegation inside, so the stall's app files it only after checking, with no trust
 * in this service: the delegation is the stall's (NIP-01 id + sig, scope, `p` = the sealer), and
 * the delegate's signature covers the sale and its pi_ reference (`delegatedSaleRow`).
 *
 * ## Delivery cannot fail a purchase
 *
 * The coupon exists before this runs. A record that does not land is not a lost sale: the stall
 * can still read the coupon, and the pull fallback re-sends it (see `resendSaleRecords`). So this
 * never throws and never changes a discharge outcome.
 *
 * Restated rather than imported from `src/` (the Dockerfile forbids reaching outside this tree).
 * `src/lib/__tests__/cardSaleRecordIssuer.test.ts` pins the wire to the stall's real reader.
 */

import { hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'

import { authorization, type StallCredential } from './issuer'

/** Mirrors `SALE_DM_TYPE` in `src/lib/tillSales.ts`. */
export const SALE_DM_TYPE = 'imani-terminal-sale/1'

/** Where the gateway accepts a signed event for its cache, NIP-98 authenticated. */
export const NOSTR_EVENTS_PATH = '/api/v1/nostr/events'

/** One card sale, as the stall's ledger needs it. */
export interface CardSale {
  voucherId: string
  faceValue: number
  faceUnit: string
  faceDecimals: number
  memo: string
  /** The buyer, when known. */
  recipientPubkey?: string
  /** Epoch ms of the mint. The stall judges the delegation at this moment. */
  at: number
  /** Epoch seconds, if the gateway reported it. */
  expiresAt?: number
  /** The warrant the coupon was minted under, verbatim. */
  issuanceWarrant: string
}

/**
 * The record's JSON: one `issued` row in the NIP-60 history content shape `toContent` writes
 * (`src/lib/txRecords.ts`). No `terminal_pubkey`: this service is not a till.
 */
export function saleRecordJson(sale: CardSale, credentialId: string): string {
  return JSON.stringify({
    type: SALE_DM_TYPE,
    rows: [
      {
        type: 'issued',
        direction: 'out',
        amount: 0,
        face_value: sale.faceValue,
        face_unit: sale.faceUnit,
        face_decimals: sale.faceDecimals,
        voucher_id: sale.voucherId,
        ...(sale.recipientPubkey ? { counterparty: sale.recipientPubkey } : {}),
        memo: sale.memo,
        timestamp: Math.floor(sale.at / 1000),
        ...(sale.expiresAt !== undefined ? { expires_at: sale.expiresAt } : {}),
        issuance_warrant: sale.issuanceWarrant,
      },
    ],
    credential_voucher_id: credentialId,
  })
}

/** Gift-wrap `content` from `senderKeyHex` to `recipient` (NIP-17 kind 14, NIP-59 seal + wrap). */
export function wrapSaleRecord(senderKeyHex: string, recipient: string, content: string, nowMs: number): Event {
  const senderKey = hexToBytes(senderKeyHex)
  const sender = getPublicKey(senderKey)
  const now = Math.floor(nowMs / 1000)
  const rumor = { kind: 14, pubkey: sender, created_at: now, content, tags: [['p', recipient]] }
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: now - Math.floor(Math.random() * 600),
      tags: [],
      content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(senderKey, recipient)),
    },
    senderKey,
  )
  const throwaway = crypto.getRandomValues(new Uint8Array(32))
  return finalizeEvent(
    {
      kind: 1059,
      created_at: now - Math.floor(Math.random() * 600),
      tags: [['p', recipient]],
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(throwaway, recipient)),
    },
    throwaway,
  )
}

/**
 * Send one card sale to its stall. NEVER THROWS.
 *
 * Published through the gateway's event cache, NIP-98 signed by the lock key (as the till's
 * `devicePublisher` mirror is), where the stall's `giftWraps` reads it.
 *
 * @returns true when the gateway accepted the wrap
 */
export async function sendSaleRecord(
  baseUrl: string,
  credential: StallCredential,
  sale: CardSale,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const wrap = wrapSaleRecord(
      credential.lockKeyHex,
      credential.stallPubkey.toLowerCase(),
      saleRecordJson(sale, credential.credentialId),
      nowMs,
    )
    const url = `${baseUrl.replace(/\/$/, '')}${NOSTR_EVENTS_PATH}`
    const body = JSON.stringify({
      id: wrap.id,
      pubkey: wrap.pubkey,
      createdAt: wrap.created_at,
      kind: wrap.kind,
      tags: wrap.tags,
      content: wrap.content,
      sig: wrap.sig,
    })
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization('POST', url, body, credential.lockKeyHex),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      console.warn(JSON.stringify({ event: 'sale_record_refused', status: response.status }))
    }
    return response.ok
  } catch (error) {
    console.warn(
      JSON.stringify({ event: 'sale_record_unsent', reason: error instanceof Error ? error.message : String(error) }),
    )
    return false
  }
}

/**
 * The pull fallback: rebuild the sale record of a purchase already discharged, so the stall can
 * be sent a card sale it missed. Safe to send any number of times: the stall files by
 * `issued:<voucher>` and skips an id it has.
 *
 * The warrant is DETERMINISTIC (`delegatedWarrant`: derived nonce, zero aux randomness), so for
 * the same purchase, credential and delegation it is byte-identical to the one the coupon was
 * minted under. After a delegation renewal it differs in the `delegation` only; the stall still
 * verifies it at the sale time.
 *
 * The caller is `salePull.ts` (imani-wallet#275 item 3): the stall's wallet asks on login, and the
 * purchases come from payment-adapter's `GET /api/v1/purchases?stall=`, read with the issuer token.
 */
export async function resendSaleRecords(
  baseUrl: string,
  credential: StallCredential,
  sales: readonly CardSale[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: number; failed: string[] }> {
  let sent = 0
  const failed: string[] = []
  for (const sale of sales) {
    if (await sendSaleRecord(baseUrl, credential, sale, fetchImpl)) sent += 1
    else failed.push(sale.voucherId)
  }
  return { sent, failed }
}
