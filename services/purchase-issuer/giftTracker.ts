/**
 * Claimed / expired notices for a delivered locked gift (#410 G15, contract §4.3).
 *
 * After a handle or email gift is discharged, one row per draft is kept in a small durable file
 * (`PURCHASE_GIFT_TRACKER_PATH`, 0600, atomic rename). The row holds the proofs' `Y` points
 * (`hash_to_curve(secret)`, NUT-00), never a token or secret, and the buyer's email sealed with
 * AES-256-GCM under the existing vault key (AAD = the draft id, so a sealed address cannot be moved
 * onto another row).
 *
 * The sweep (once per worker pass, each gift at most once per 10 min) asks the mint (NUT-07):
 * - all SPENT before claimBy: `gift-claimed` (`<draftId>:claimed`), row dropped;
 * - all UNSPENT at or after claimBy: `gift-expired` once (`<draftId>:expired`), kept until a later
 *   SPENT (take-back or late claim, no email) or claimBy + 7 d;
 * - any SPENT at or after claimBy: no email, row dropped;
 * - anything else (PENDING, UNKNOWN, mixed, mint down): next pass.
 *
 * Logs and metrics carry no address, draft id or amount.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hashToCurve } from '@cashu/crypto/modules/common'

import type { SendOutcome, SendRequest } from '../imani-mailer/mailer.ts'
import { decodeCbor, proofSecrets } from '../../src/lib/voucherToken'
import { countGiftNotice, countGiftSweepError } from './metrics'

export const SWEEP_EVERY_MS = 10 * 60_000
export const KEEP_AFTER_CLAIM_BY_MS = 7 * 86_400_000

export type ProofState = 'SPENT' | 'UNSPENT' | 'PENDING' | 'UNKNOWN'

export interface TrackedGift {
  draftId: string
  kind: 'handle' | 'email'
  mintUrl: string
  ys: string[]
  /** Unix ms. */
  claimBy: number
  /** `{iv, sealed}` base64, AES-256-GCM, AAD = draftId. */
  buyerEmail: { iv: string; sealed: string }
  recipientDisplay: string
  stall: string
  amount: string
  guest: boolean
  /** Display date the guest's return link was mailed, or null when not known. */
  returnMailDate: string | null
  /** G17: the voucher's own expiry (unix ms), kept by a gift taken back unclaimed; null = never. Absent on rows tracked before G17. */
  spendBy?: number | null
  notified: { claimed?: number; expired?: number }
  /** Last time the mint was asked (rate limit), unix ms. */
  checkedAt?: number
}

/** What discharge hands the tracker. Plain buyer email: sealed before it touches disk. */
export interface TrackInput {
  draftId: string
  kind: 'handle' | 'email'
  token: string
  claimBy: number
  buyerEmail: string
  recipientDisplay: string
  stall: string
  amount: string
  guest: boolean
  returnMailDate: string | null
  /** G17: the voucher's own expiry, unix ms; null when it never expires. */
  spendBy?: number | null
}

export interface TrackerStore {
  read(): Promise<Record<string, TrackedGift>>
  write(rows: Record<string, TrackedGift>): Promise<void>
}

export interface TrackerPorts {
  /** How long between two mint checks of one gift. Default `SWEEP_EVERY_MS`. */
  sweepEveryMs?: number
  checkStates(mintUrl: string, ys: string[]): Promise<Map<string, ProofState>>
  sendMail(req: SendRequest): Promise<SendOutcome>
  now(): number
}

/** `Y = hash_to_curve(secret)`, compressed hex, exactly as the mint and wallet-api compute it. */
export function hashToCurveHex(secret: string): string {
  return hashToCurve(new TextEncoder().encode(secret)).toHex(true)
}

/** The token's mint URL (TokenV4 `m`). Throws when there is none. */
export function tokenMintUrl(token: string): string {
  if (!token.startsWith('cashuB')) throw new Error('not a TokenV4 (cashuB) token')
  const root = decodeCbor(Buffer.from(token.slice(6), 'base64url')) as Record<string, unknown>
  const m = typeof root.m === 'string' ? root.m.trim() : ''
  if (!/^https?:\/\//.test(m)) throw new Error('token names no mint URL')
  return m
}

/** `03 Jan 2027` style, the same as the claim email's claimBy. */
export function displayDate(ms: number): string {
  return new Date(ms).toUTCString().slice(5, 16)
}

export function howBack(row: Pick<TrackedGift, 'guest' | 'stall' | 'returnMailDate'>): string {
  if (!row.guest) return 'Open your Imani wallet: it takes it back for you.'
  const when = row.returnMailDate ? ` on ${row.returnMailDate}` : ''
  return `Take it back with the return link we emailed you${when} (subject "If your ${row.stall} gift isn't claimed").`
}

/**
 * G17 (C): what a gift taken back still has. It keeps its original expiry, so the buyer is told
 * the date. Null when unknown (a row from before G17): the email then says nothing rather than guess.
 */
export function spendByLine(row: Pick<TrackedGift, 'spendBy'>): string | null {
  if (row.spendBy === undefined) return null
  if (row.spendBy === null) return "Once it's back, the voucher doesn't expire."
  return `Once it's back, it keeps its original expiry: spend it by ${displayDate(row.spendBy)}.`
}

export class GiftTracker {
  private readonly key: Buffer
  private chain: Promise<unknown> = Promise.resolve()

  private readonly store: TrackerStore
  private readonly ports: TrackerPorts

  constructor(keyHex: string, store: TrackerStore, ports: TrackerPorts) {
    this.store = store
    this.ports = ports
    const key = Buffer.from(keyHex, 'hex')
    if (key.length !== 32) throw new Error('gift tracker key must be 32 bytes of hex')
    this.key = key
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.catch(() => undefined)
    return run
  }

  private seal(draftId: string, email: string): { iv: string; sealed: string } {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key, iv)
    c.setAAD(Buffer.from(`imani-gift-tracker:${draftId}`))
    const ct = Buffer.concat([c.update(email, 'utf8'), c.final(), c.getAuthTag()])
    return { iv: iv.toString('base64'), sealed: ct.toString('base64') }
  }

  private open(row: TrackedGift): string {
    const iv = Buffer.from(row.buyerEmail.iv, 'base64')
    const all = Buffer.from(row.buyerEmail.sealed, 'base64')
    const d = createDecipheriv('aes-256-gcm', this.key, iv)
    d.setAAD(Buffer.from(`imani-gift-tracker:${row.draftId}`))
    d.setAuthTag(all.subarray(all.length - 16))
    return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8')
  }

  /** Record (or replace) one delivered gift. Throws when the token has no proofs or the store fails. */
  track(input: TrackInput, mintUrl: string): Promise<void> {
    const ys = proofSecrets(input.token).map(hashToCurveHex)
    if (ys.length === 0) throw new Error('gift token has no proofs')
    const row: TrackedGift = {
      draftId: input.draftId,
      kind: input.kind,
      mintUrl,
      ys,
      claimBy: input.claimBy,
      buyerEmail: this.seal(input.draftId, input.buyerEmail),
      recipientDisplay: input.recipientDisplay,
      stall: input.stall,
      amount: input.amount,
      guest: input.guest,
      returnMailDate: input.returnMailDate,
      ...(input.spendBy !== undefined ? { spendBy: input.spendBy } : {}),
      notified: {},
    }
    return this.serial(async () => {
      const rows = await this.store.read()
      // A re-drive of the same draft keeps what was already notified.
      const prior = rows[input.draftId]
      rows[input.draftId] = prior ? { ...row, notified: prior.notified } : row
      await this.store.write(rows)
    })
  }

  /** One sweep. Never throws for a single gift; a store that cannot be read throws. */
  sweep(): Promise<{ claimed: number; expired: number; dropped: number }> {
    return this.serial(async () => {
      const rows = await this.store.read()
      const out = { claimed: 0, expired: 0, dropped: 0 }
      const now = this.ports.now()
      let changed = false
      for (const [id, row] of Object.entries(rows)) {
        if (now >= row.claimBy + KEEP_AFTER_CLAIM_BY_MS) {
          delete rows[id]
          out.dropped += 1
          changed = true
          continue
        }
        if (row.checkedAt !== undefined && now - row.checkedAt < (this.ports.sweepEveryMs ?? SWEEP_EVERY_MS)) continue
        row.checkedAt = now
        changed = true
        let states: Map<string, ProofState>
        try {
          states = await this.ports.checkStates(row.mintUrl, row.ys)
        } catch {
          countGiftSweepError()
          continue
        }
        const each = row.ys.map((y) => states.get(y.toLowerCase()) ?? 'UNKNOWN')
        const allSpent = each.every((s) => s === 'SPENT')
        const anySpent = each.some((s) => s === 'SPENT')
        const allUnspent = each.every((s) => s === 'UNSPENT')
        if (now < row.claimBy) {
          if (!allSpent) continue
          const sent = await this.notify(row, 'claimed')
          if (sent !== 'retry') {
            delete rows[id]
            if (sent === 'sent') out.claimed += 1
            out.dropped += 1
          }
          continue
        }
        if (anySpent) {
          delete rows[id]
          out.dropped += 1
          continue
        }
        if (allUnspent && row.notified.expired === undefined) {
          const sent = await this.notify(row, 'expired')
          if (sent === 'sent') {
            row.notified.expired = now
            out.expired += 1
          } else if (sent === 'refused') {
            // Permanent refusal: no point tracking a notice that can never be sent.
            delete rows[id]
            out.dropped += 1
          }
        }
      }
      if (changed) await this.store.write(rows)
      return out
    })
  }

  private async notify(row: TrackedGift, kind: 'claimed' | 'expired'): Promise<'sent' | 'retry' | 'refused'> {
    let to: string
    try {
      to = this.open(row)
    } catch {
      countGiftSweepError()
      return 'refused'
    }
    const fields: Record<string, string> =
      kind === 'claimed'
        ? { stall: row.stall, amount: row.amount, recipient: row.recipientDisplay }
        : {
            stall: row.stall,
            amount: row.amount,
            recipient: row.recipientDisplay,
            claimBy: displayDate(row.claimBy),
            howBack: howBack(row),
            ...(spendByLine(row) ? { spendBy: spendByLine(row)! } : {}),
          }
    let res: SendOutcome
    try {
      res = await this.ports.sendMail({ template: `gift-${kind}`, to, fields, idempotencyKey: `${row.draftId}:${kind}` })
    } catch {
      countGiftSweepError()
      return 'retry'
    }
    if (res.ok) {
      countGiftNotice(kind)
      return 'sent'
    }
    countGiftSweepError()
    return res.retryable ? 'retry' : 'refused'
  }
}

/** The durable store: one JSON file, 0600, written atomically. Missing is empty; corrupt throws. */
export function fileTrackerStore(path: string): TrackerStore {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as Record<string, TrackedGift>
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw error
      }
    },
    async write(rows) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(`${path}.tmp`, JSON.stringify(rows), { mode: 0o600 })
      await rename(`${path}.tmp`, path)
    },
  }
}

/**
 * NUT-07 `checkstate` over HTTP. `transportUrl`, when set, replaces the coupon mint's origin (a
 * local stack whose coupons name a host-only mint URL the container cannot reach).
 */
export function httpCheckStates(transportUrl: string | null, fetchImpl: typeof fetch = fetch) {
  return async (mintUrl: string, ys: string[]): Promise<Map<string, ProofState>> => {
    const base = (transportUrl ?? mintUrl).trim().replace(/\/+$/, '')
    const r = await fetchImpl(`${base}/v1/checkstate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Ys: [...new Set(ys)] }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) throw new Error(`mint answered ${r.status}`)
    const json = (await r.json()) as { states?: Array<{ Y?: unknown; state?: unknown }> }
    const out = new Map<string, ProofState>()
    for (const s of json.states ?? []) {
      if (typeof s.Y !== 'string') continue
      out.set(s.Y.toLowerCase(), s.state === 'SPENT' || s.state === 'UNSPENT' || s.state === 'PENDING' ? s.state : 'UNKNOWN')
    }
    return out
  }
}
