/**
 * The sales ledger (#407 §8): who bought what, until when, and every licence minted for it.
 *
 * NOT a licence server. Nothing reads this to grant a feature; the wallet verifies the signed
 * licence it holds. This is the record needed to renew, to re-send, to invoice and to answer a
 * support question, keyed by subscription id and stall pubkey and nothing personal.
 *
 * A JSON file written atomically (temp + rename), as `purchase-issuer`'s outbox is: one writer, a
 * few hundred rows, and no database to operate. Corrupt THROWS, because reading it as empty would
 * forget every paying customer.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type LicenceState = 'owed' | 'minted' | 'delivered' | 'failed'

export interface IssuedLicence {
  /** One per Stripe invoice (or grant), so a webhook replay mints nothing twice. */
  key: string
  validFrom: number
  validTo: number
  state: LicenceState
  voucherId?: string
  /** The token as delivered, kept so the wallet can ask for it again (`/v1/licences/mine`). */
  token?: string
  attempts: number
  lastError?: string
}

export interface SubscriptionRow {
  subscriptionId: string
  stallPubkey: string
  tier: string
  term: 'monthly' | 'annual' | 'custom'
  grantKind: 'subscription' | 'custom'
  status: 'active' | 'cancelled' | 'revoked'
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  /** For a hand grant: its own limits, who issued it and why (#407 §7). */
  limits?: unknown
  features?: string[]
  issuedBy?: string
  reason?: string
  pilot?: boolean
  paidAmountMinor: number
  paidCurrency: string
  createdAt: number
  /**
   * Unix SECONDS: when it was last marked cancelled (cleared if a cancellation is undone). Rows
   * written before this field existed have none; metrics then fall back to "unknown when".
   */
  cancelledAt?: number
  licences: IssuedLicence[]
}

export class Ledger {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly path: string
  constructor(path: string) {
    this.path = path
  }

  async all(): Promise<SubscriptionRow[]> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const decoded: unknown = JSON.parse(raw)
    if (!Array.isArray(decoded)) throw new Error(`ledger ${this.path} is not a JSON array`)
    return decoded as SubscriptionRow[]
  }

  /** Read-modify-write, serialised so two webhooks cannot lose each other's change. */
  update<T>(change: (rows: SubscriptionRow[]) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const rows = await this.all()
      const result = change(rows)
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      await writeFile(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 })
      await rename(tmp, this.path)
      return result
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  async forStall(pubkey: string): Promise<SubscriptionRow[]> {
    return (await this.all()).filter((r) => r.stallPubkey === pubkey)
  }
}

/** Random, so it says nothing about the customer (matches `newSubscriptionId` in the script). */
export function newSubscriptionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `sub_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}
