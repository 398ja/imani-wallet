/**
 * The delivery outbox (imani-wallet#274, card atomicity audit U8).
 *
 * Once a coupon exists, two things are still owed and neither may be lost: the buyer's DM, and the
 * stall's sale record (#275, U9). Before this, a failed DM parked the row ISSUED forever (audit S4,
 * staging S1 C) and a failed sale record was simply dropped.
 *
 * So after a mint, whatever did not land is written HERE, durably, before the purchases API is told
 * anything. A delivery loop then works it off with capped exponential backoff, and after
 * `maxAttempts` deliveries it parks the row `delivery_exhausted` (payment-adapter#280,
 * `POST /{eventId}/attention`, naming the voucher) for a person. Never stuck, never silent.
 *
 * ## What is stored, and what is not
 *
 * Ids only: event, voucher, issuer, stall, recipient, payment request, and the sale record's public
 * fields (its warrant is public by design). **Never the token.** A bearer token on disk is value
 * sitting in a file; the loop re-reads it from the gateway (`tokenFor`, gc#229) at delivery time.
 *
 * ## Restart safety
 *
 * The file is written atomically (tmp + rename, 0600). A restart reads it back and carries on. A
 * crash between the mint and this write loses nothing either: the worker then leaves the claim to
 * lapse, the row is re-claimed, and the re-mint under the same pi_ nonce gets the ORIGINAL voucher
 * back from gc (#232), which re-enters the outbox. A corrupt file is refused at start, never read as
 * empty: forgetting a queued delivery is the one failure this exists to prevent.
 *
 * One process per file. Replicas each need their own volume; the claim already keeps them off one
 * row's mint, and a row's outbox entry lives with the process that minted it.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { DeliveredUnconfirmed, DeliveryRefused, deliver } from './delivery'
import type { Ports } from './discharge'
import { countAttempt } from './metrics'
import type { PurchasesApi } from './purchasesApi'
import type { CardSale } from './saleRecord'

export interface OutboxEntry {
  eventId: string
  voucherId: string
  issuerId: string
  stallPubkey: string
  recipientPubkey: string
  paymentRequestId: string
  /** True while the DM has not been confirmed sent. */
  deliver: boolean
  /** Deliveries tried so far, the inline one included. */
  attempts: number
  /** The sale record still to file, or null once filed (or never owed). */
  sale: CardSale | null
  saleAttempts: number
  /** Epoch ms before which this entry is not retried. */
  nextAt: number
  /** Set once delivery is exhausted but the attention report has not landed yet. */
  exhausted?: boolean
  lastError?: string
}

export interface OutboxStore {
  read(): Promise<OutboxEntry[]>
  write(entries: OutboxEntry[]): Promise<void>
}

export class MemoryOutboxStore implements OutboxStore {
  private entries: OutboxEntry[] = []
  async read(): Promise<OutboxEntry[]> {
    return this.entries.map((e) => ({ ...e }))
  }
  async write(entries: OutboxEntry[]): Promise<void> {
    this.entries = entries.map((e) => ({ ...e }))
  }
}

/** A JSON file on the issuer's volume, beside the credentials. */
export class FileOutboxStore implements OutboxStore {
  private readonly path: string
  constructor(path: string) {
    this.path = path
  }

  async read(): Promise<OutboxEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      // Missing is the ordinary state: nothing has ever been queued.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    // Corrupt THROWS. Reading it as empty would forget every queued delivery.
    const decoded: unknown = JSON.parse(raw)
    if (!Array.isArray(decoded)) throw new Error(`outbox ${this.path} is not a JSON array`)
    return decoded as OutboxEntry[]
  }

  async write(entries: OutboxEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(entries, null, 2), { mode: 0o600 })
    await rename(temporary, this.path)
  }
}

export interface OutboxOptions {
  now: () => number
  /** Deliveries before the row is parked `delivery_exhausted`. */
  maxAttempts: number
  baseBackoffMs: number
  maxBackoffMs: number
}

export const DEFAULT_OUTBOX_OPTIONS: Omit<OutboxOptions, 'now'> = {
  // ~1 min, 2, 4, 8, 16, 32, then hourly: 12 attempts is roughly six hours of relay outage.
  maxAttempts: 12,
  baseBackoffMs: 60_000,
  maxBackoffMs: 3_600_000,
}

export class DeliveryOutbox {
  private readonly store: OutboxStore
  readonly options: OutboxOptions
  constructor(store: OutboxStore, options: OutboxOptions) {
    this.store = store
    this.options = options
  }

  /** Wait after the `n`th attempt: base * 2^(n-1), capped. */
  backoffMs(n: number): number {
    return Math.min(this.options.maxBackoffMs, this.options.baseBackoffMs * 2 ** Math.max(0, n - 1))
  }

  /** Queue (or replace) one entry. Throws when it could not be made durable. */
  async put(entry: Omit<OutboxEntry, 'nextAt'> & { nextAt?: number }): Promise<void> {
    const entries = (await this.store.read()).filter((e) => e.eventId !== entry.eventId)
    entries.push({
      ...entry,
      nextAt: entry.nextAt ?? this.options.now() + this.backoffMs(Math.max(1, entry.deliver ? entry.attempts : entry.saleAttempts)),
    })
    await this.store.write(entries)
  }

  async due(): Promise<OutboxEntry[]> {
    const now = this.options.now()
    return (await this.store.read()).filter((e) => e.nextAt <= now)
  }

  async remove(eventId: string): Promise<void> {
    await this.store.write((await this.store.read()).filter((e) => e.eventId !== eventId))
  }

  async size(): Promise<number> {
    return (await this.store.read()).length
  }
}

export interface DeliveryDeps {
  outbox: DeliveryOutbox
  api: PurchasesApi
  ports: Ports
  gatewayUrl: string
  workerId?: string
}

export interface DeliveryPassResult {
  delivered: number
  retried: number
  exhausted: number
  salesFiled: number
}

/**
 * One pass over what is due. Never throws for one entry: a bad row must not stop the others.
 * A store write that fails does throw, because then this process can no longer keep its queue.
 */
export async function runDeliveryPass(deps: DeliveryDeps): Promise<DeliveryPassResult> {
  const result: DeliveryPassResult = { delivered: 0, retried: 0, exhausted: 0, salesFiled: 0 }
  const { outbox, api, ports } = deps

  for (const entry of await outbox.due()) {
    const next: OutboxEntry = { ...entry }
    const credential = await ports.credentialFor(entry.stallPubkey).catch(() => null)

    if (next.deliver && !next.exhausted) {
      if (credential === null) {
        next.lastError = 'no issuing credential for this stall'
        next.attempts += 1
      } else {
        try {
          const token = await ports.tokenFor(credential, entry.voucherId)
          await deliver(
            deps.gatewayUrl,
            credential,
            { kind: 'pubkey', pubkey: entry.recipientPubkey },
            token,
            entry.paymentRequestId,
            entry.voucherId,
            fetch,
            () => ports.now(),
          )
          next.deliver = false
          result.delivered += 1
          countAttempt('delivered_late')
          // The send is recorded against the payment request; ask PA to close the debt. Anything
          // short of accepted is left to PA's recheck, which re-verifies ISSUED rows with backoff.
          await api.discharge(entry.eventId, entry.voucherId, entry.issuerId)
        } catch (error) {
          next.attempts += 1
          next.lastError = error instanceof Error ? error.message : String(error)
          // Delivered, discharge not confirmed (imani-wallet#287/#289): re-sent like any failure,
          // but counted apart so a dashboard does not read it as "the buyer has nothing".
          if (error instanceof DeliveredUnconfirmed) countAttempt('delivered_unconfirmed')
          // A permanent receipt refusal (core#163): park now, no retry loop.
          if (error instanceof DeliveryRefused) next.exhausted = true
        }
      }
      if (next.deliver) {
        if (next.attempts >= outbox.options.maxAttempts) {
          next.exhausted = true
        } else {
          result.retried += 1
          countAttempt('delivery_retried')
        }
      }
    }

    if (next.exhausted && next.deliver) {
      const parked = await api.attention(entry.eventId, 'delivery_exhausted', {
        voucherId: entry.voucherId,
        detail: (next.lastError?.includes('refused the discharge receipt permanently')
          ? next.lastError
          : `delivery failed ${next.attempts} times: ${next.lastError ?? 'unknown'}`
        ).slice(0, 500),
        worker: deps.workerId,
      })
      if (parked === 'parked' || parked === 'unsupported' || parked === 'refused') {
        // Unsupported = a payment-adapter without #280. The row is already ISSUED with its voucher
        // (the inline failure report said so); the log line is the only signal left.
        // Refused (409) = the row is closed: PA's recheck discharged it, or it was refunded. An
        // ISSUED row has no live claim, so nothing else answers 409. Kept, it would ask again
        // every hour forever (review of #279).
        console.error(
          JSON.stringify({
            event: 'purchase_delivery_exhausted',
            event_id: entry.eventId,
            voucher_id: entry.voucherId,
            parked: parked === 'parked',
            ...(parked === 'refused' ? { closed: true } : {}),
          }),
        )
        next.deliver = false
        result.exhausted += 1
        countAttempt('delivery_exhausted')
      }
      // Otherwise the report did not land: kept, and tried again next pass.
    }

    if (next.sale !== null && credential !== null && ports.fileSale) {
      const filed = await ports.fileSale(credential, next.sale).catch(() => false)
      next.saleAttempts += 1
      if (filed) {
        next.sale = null
        result.salesFiled += 1
      } else if (next.saleAttempts >= outbox.options.maxAttempts) {
        // A missed sale record is not lost value: the coupon is the stall's and the pull fallback
        // (`resendSaleRecords`) can re-send it. Logged and dropped, never retried forever.
        console.warn(JSON.stringify({ event: 'purchase_sale_record_exhausted', voucher_id: entry.voucherId }))
        next.sale = null
      }
    }

    if (!next.deliver && next.sale === null) {
      await outbox.remove(entry.eventId)
    } else {
      await outbox.put({ ...next, nextAt: undefined, attempts: next.attempts })
    }
  }
  return result
}
