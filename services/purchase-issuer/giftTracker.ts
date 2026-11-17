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
 * #410 §6d expiry reminders: an unclaimed email (or code) gift also holds the RECIPIENT's email,
 * sealed like the buyer's (AAD = draftId + ':recipient'). Before claimBy, each pass that finds every
 * proof still UNSPENT sends the latest due reminder (default 7 d and 1 d before claimBy), at most
 * once per offset (`<draftId>:expiring:<offset>`), never within 1 h of claimBy, never for an offset
 * longer than the gift's window, never once unsubscribed (RFC 8058, a signed per-gift token) or
 * bounced. A hard bounce (the mailer's suppression list) sends the buyer `gift-bounced` once.
 *
 * #570 retention: a row is only dropped after payment-adapter has scrubbed every personal field of
 * its purchase (`scrub?all=true`). A scrub that fails keeps the row (finished) and is retried on
 * every sweep.
 *
 * Logs and metrics carry no address, draft id or amount.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hashToCurve } from '@cashu/crypto/modules/common'

import type { SendOutcome, SendRequest } from '../imani-mailer/mailer.ts'
import { decodeCbor, proofSecrets } from '../../src/lib/voucherToken'
import { countGiftNotice, countGiftSweepError } from './metrics'

export const SWEEP_EVERY_MS = 10 * 60_000
export const KEEP_AFTER_CLAIM_BY_MS = 7 * 86_400_000
/** §6c default reminder offsets before claimBy. */
export const DEFAULT_REMINDER_OFFSETS_MS = [7 * 86_400_000, 86_400_000]
/** §Edge cases, clock skew: no reminder within this long of claimBy. */
export const REMINDER_MARGIN_MS = 3_600_000

type Sealed = { iv: string; sealed: string }

export type ProofState = 'SPENT' | 'UNSPENT' | 'PENDING' | 'UNKNOWN'

export interface TrackedGift {
  draftId: string
  kind: 'handle' | 'email' | 'code'
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
  /**
   * #410 code gifts: the code (sealed like the email, AAD = draftId + ':code'), how the amounts are
   * shown, and the last remaining value the public code-check reported (minor units).
   */
  codeGift?: { code: { iv: string; sealed: string }; decimals: number; unit: string; lastRemaining: number; amountMinor?: number }
  /**
   * Business metrics: the latest outcome seen for this gift, until payment-adapter has it
   * (`sent`). payment-adapter owns every gift state; this tracker only reports what it alone sees.
   */
  report?: { outcome: GiftOutcome; remainingMinor?: number; sent?: boolean }
  /** The sweep is done with this row and keeps it only until its report is delivered and its purchase scrubbed. */
  finished?: boolean
  /** #570: the purchase's event id, for `scrub?all=true`. Absent on rows from before #570. */
  eventId?: string
  /** #570: payment-adapter has dropped the purchase's personal fields. */
  scrubbed?: boolean
  /** When it was tracked (unix ms): the claim email's date, and the start of its window. */
  trackedAt?: number
  /** §6d: the recipient's email (AAD = draftId + ':recipient'), and what the reminder names. */
  recipient?: { email: Sealed; from: string | null; claimSubject: string; sender: string }
  /** §6c: reminder offsets (ms before claimBy) already sent or passed over, with when. */
  reminders?: Record<string, number>
  /** RFC 8058 one-click unsubscribe: no more reminders for this gift. */
  unsubscribed?: number
  /** Hard bounce seen, and the buyer told (`gift-bounced`). No reminders after it. */
  bounced?: number
}

/**
 * What the recipient did, as payment-adapter's `POST /api/v1/purchases/gifts/{draftId}/outcome`
 * takes it. Mapping from what this tracker observes (and the contract state payment-adapter files
 * it under):
 * - voucher, every proof SPENT before claimBy: CLAIMED (redeemed);
 * - voucher, every proof UNSPENT at or after claimBy: EXPIRED (expired);
 * - voucher, any proof SPENT at or after claimBy: RETURNED (returned). The mint cannot tell a
 *   buyer's take-back from a late claim; a take-back is what the expiry path invites, so it is the
 *   nearest honest bucket;
 * - code, remaining dropped but not to zero: PARTLY_USED with the remaining balance (outstanding,
 *   spent part redeemed);
 * - code, remaining reached zero: CLAIMED (redeemed);
 * - code, expired with value left: EXPIRED with the last remaining balance (expired).
 */
export type GiftOutcome = 'CLAIMED' | 'PARTLY_USED' | 'EXPIRED' | 'RETURNED'

/** `ok` delivered (or already final there); `gone` will never be accepted; `retry` try next sweep. */
export type ReportResult = 'ok' | 'gone' | 'retry'

/** What discharge hands the tracker. Plain buyer email: sealed before it touches disk. */
export interface TrackInput {
  draftId: string
  kind: 'handle' | 'email' | 'code'
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
  /** #410: a code gift, tracked through the public code-check instead of the mint. */
  code?: { code: string; amountMinor: number; decimals: number; unit: string }
  /** #570: the purchase's event id, scrubbed (`all=true`) when the row is done. */
  eventId?: string
  /**
   * §6d: an email or code gift's recipient, for expiry reminders and bounce checks: their address
   * (sealed before it touches disk), the sender's "from" name, and the claim email's subject and
   * From address (G13: the reminder names the email, never the link).
   */
  recipient?: { email: string; from: string | null; claimSubject: string; sender: string }
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
  /** #410: the public `GET /v1/code-check/{code}`. Absent, code rows are kept but never checked. */
  checkCode?(code: string): Promise<{ status: 'active' | 'in_use' | 'used' | 'expired'; remaining: number }>
  /** Business metrics: tell payment-adapter a gift's outcome. Absent, nothing is reported. */
  reportOutcome?(draftId: string, outcome: GiftOutcome, remainingMinor?: number): Promise<ReportResult>
  /** #570: payment-adapter's `scrub?all=true`. Absent, rows are dropped without it (tests, old wiring). */
  scrubAll?(eventId: string): Promise<ReportResult>
  /** §6c reminder offsets, ms before claimBy. Default `DEFAULT_REMINDER_OFFSETS_MS`; [] turns reminders off. */
  reminderOffsetsMs?: number[]
  /**
   * The RFC 8058 one-click URL for a gift's reminders, from `unsubscribeToken`. Absent (no public
   * origin), no reminder is sent: every reminder must carry one (§6d).
   */
  unsubscribeUrl?(draftId: string, token: string): string
  /** Hard-bounce check against imani-mailer's suppressions. Absent, bounces are not looked for. */
  isBounced?(email: string): Promise<boolean>
}

/** Minor units as a currency, as discharge formats the gift amount. */
export function formatMinor(minor: number, decimals: number, unit: string): string {
  const major = (minor / 10 ** decimals).toFixed(decimals)
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: unit }).format(Number(major))
  } catch {
    return `${major} ${unit}`
  }
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
  private readonly unsubKey: Buffer
  private chain: Promise<unknown> = Promise.resolve()

  private readonly store: TrackerStore
  private readonly ports: TrackerPorts

  constructor(keyHex: string, store: TrackerStore, ports: TrackerPorts) {
    this.store = store
    this.ports = ports
    const key = Buffer.from(keyHex, 'hex')
    if (key.length !== 32) throw new Error('gift tracker key must be 32 bytes of hex')
    this.key = key
    this.unsubKey = createHmac('sha256', key).update('imani-gift-unsubscribe-v1').digest()
  }

  /** The signed per-gift unsubscribe token (HMAC of the draft id under a key derived from the vault key). */
  unsubscribeToken(draftId: string): string {
    return createHmac('sha256', this.unsubKey).update(draftId).digest('base64url')
  }

  /** True when `token` is this gift's unsubscribe token. Constant time. */
  verifyUnsubscribe(draftId: string, token: string): boolean {
    const want = Buffer.from(this.unsubscribeToken(draftId))
    const got = Buffer.from(token)
    return got.length === want.length && timingSafeEqual(got, want)
  }

  /**
   * RFC 8058 one-click: stop this gift's reminders. 'bad' for a token that is not this gift's;
   * 'ok' otherwise, also for a gift no longer tracked (nothing left to stop). Never cancels the gift.
   */
  unsubscribe(draftId: string, token: string): Promise<'ok' | 'bad'> {
    if (!this.verifyUnsubscribe(draftId, token)) return Promise.resolve('bad')
    return this.serial(async () => {
      const rows = await this.store.read()
      const row = rows[draftId]
      if (row && row.unsubscribed === undefined) {
        row.unsubscribed = this.ports.now()
        await this.store.write(rows)
      }
      return 'ok' as const
    })
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.catch(() => undefined)
    return run
  }

  private seal(draftId: string, email: string, aad = `imani-gift-tracker:${draftId}`): { iv: string; sealed: string } {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key, iv)
    c.setAAD(Buffer.from(aad))
    const ct = Buffer.concat([c.update(email, 'utf8'), c.final(), c.getAuthTag()])
    return { iv: iv.toString('base64'), sealed: ct.toString('base64') }
  }

  private open(row: TrackedGift, box = row.buyerEmail, aad = `imani-gift-tracker:${row.draftId}`): string {
    const iv = Buffer.from(box.iv, 'base64')
    const all = Buffer.from(box.sealed, 'base64')
    const d = createDecipheriv('aes-256-gcm', this.key, iv)
    d.setAAD(Buffer.from(aad))
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
      // The recipient's address is never kept in clear: shown from the sealed copy instead.
      recipientDisplay: input.recipient && input.recipientDisplay.trim().toLowerCase() === input.recipient.email.trim().toLowerCase() ? '' : input.recipientDisplay,
      stall: input.stall,
      amount: input.amount,
      guest: input.guest,
      returnMailDate: input.returnMailDate,
      ...(input.spendBy !== undefined ? { spendBy: input.spendBy } : {}),
      ...(input.code
        ? {
            codeGift: {
              code: this.seal(input.draftId, input.code.code, `imani-gift-tracker:${input.draftId}:code`),
              decimals: input.code.decimals,
              unit: input.code.unit,
              lastRemaining: input.code.amountMinor,
              amountMinor: input.code.amountMinor,
            },
          }
        : {}),
      notified: {},
      trackedAt: this.ports.now(),
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.recipient
        ? {
            recipient: {
              email: this.seal(input.draftId, input.recipient.email, `imani-gift-tracker:${input.draftId}:recipient`),
              from: input.recipient.from,
              claimSubject: input.recipient.claimSubject,
              sender: input.recipient.sender,
            },
          }
        : {}),
    }
    return this.serial(async () => {
      const rows = await this.store.read()
      // A re-drive of the same draft keeps what was already notified.
      const prior = rows[input.draftId]
      rows[input.draftId] = prior
        ? {
            ...row,
            notified: prior.notified,
            ...(prior.codeGift && row.codeGift ? { codeGift: { ...row.codeGift, lastRemaining: prior.codeGift.lastRemaining } } : {}),
            ...(prior.trackedAt !== undefined ? { trackedAt: prior.trackedAt } : {}),
            ...(prior.reminders ? { reminders: prior.reminders } : {}),
            ...(prior.unsubscribed !== undefined ? { unsubscribed: prior.unsubscribed } : {}),
            ...(prior.bounced !== undefined ? { bounced: prior.bounced } : {}),
          }
        : row
      await this.store.write(rows)
    })
  }

  /** One sweep. Never throws for a single gift; a store that cannot be read throws. */
  sweep(): Promise<{ claimed: number; expired: number; dropped: number; reminded: number; bounced: number }> {
    return this.serial(async () => {
      const rows = await this.store.read()
      const out = { claimed: 0, expired: 0, dropped: 0, reminded: 0, bounced: 0 }
      const now = this.ports.now()
      let changed = false
      // Done with a row: it is kept (finished) until its report is delivered and its purchase scrubbed.
      const finish = async (id: string) => {
        rows[id].finished = true
        out.dropped += 1
        changed = true
        await this.deliverReport(rows[id])
        await this.release(rows, id, now)
      }
      for (const [id, row] of Object.entries(rows)) {
        if (row.report && !row.report.sent && this.ports.reportOutcome) {
          if (await this.deliverReport(row)) changed = true
        }
        if (row.finished) {
          if (await this.release(rows, id, now)) changed = true
          continue
        }
        if (now >= row.claimBy + KEEP_AFTER_CLAIM_BY_MS) {
          await finish(id)
          continue
        }
        if (row.checkedAt !== undefined && now - row.checkedAt < (this.ports.sweepEveryMs ?? SWEEP_EVERY_MS)) continue
        row.checkedAt = now
        changed = true
        if (await this.checkBounce(row, now)) out.bounced += 1
        if (row.kind === 'code') {
          const done = await this.sweepCode(row, now, out)
          if (done) await finish(id)
          else await this.deliverReport(row)
          continue
        }
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
          if (allUnspent) {
            // A fresh "still unspent" from the mint, just now: the only time a reminder may go.
            if (await this.remind(row, now)) out.reminded += 1
            continue
          }
          if (!allSpent) continue
          this.observe(row, 'CLAIMED')
          const sent = await this.notify(row, 'claimed')
          if (sent !== 'retry') {
            if (sent === 'sent') out.claimed += 1
            await finish(id)
          } else await this.deliverReport(row)
          continue
        }
        if (anySpent) {
          this.observe(row, 'RETURNED')
          await finish(id)
          continue
        }
        if (allUnspent) {
          this.observe(row, 'EXPIRED')
          await this.deliverReport(row)
        }
        if (allUnspent && row.notified.expired === undefined) {
          const sent = await this.notify(row, 'expired')
          if (sent === 'sent') {
            row.notified.expired = now
            out.expired += 1
          } else if (sent === 'refused') {
            // Permanent refusal: no point tracking a notice that can never be sent. The expiry
            // is still reported (above), so the gift is not left outstanding in the metrics.
            await finish(id)
          }
        }
      }
      if (changed) await this.store.write(rows)
      return out
    })
  }

  /**
   * #570: drop a finished row once its purchase is scrubbed (`all=true`) and its report delivered.
   * A failed scrub keeps the row for the next sweep, however long that takes: payment-adapter's own
   * backstop is the only other way those fields go. True when the row changed or went.
   */
  private async release(rows: Record<string, TrackedGift>, id: string, now: number): Promise<boolean> {
    const row = rows[id]
    let changed = false
    if (!row.scrubbed && row.eventId && this.ports.scrubAll) {
      let result: ReportResult
      try {
        result = await this.ports.scrubAll(row.eventId)
      } catch {
        result = 'retry'
      }
      if (result === 'retry') {
        countGiftSweepError()
        return false
      }
      row.scrubbed = true
      changed = true
    }
    // Undeliverable for the whole keep window: give up, payment-adapter keeps its last state.
    const reportOpen = !!row.report && !row.report.sent && !!this.ports.reportOutcome && now < row.claimBy + KEEP_AFTER_CLAIM_BY_MS
    if (reportOpen) return changed
    delete rows[id]
    return true
  }

  /**
   * Hard bounce (§Recipient: email): the recipient's address is on the mailer's suppression list.
   * The buyer is told once (`gift-bounced`, `<draftId>:bounced`) and reminders stop. True when the
   * buyer was told on this pass.
   */
  private async checkBounce(row: TrackedGift, now: number): Promise<boolean> {
    if (!row.recipient || row.bounced !== undefined || !this.ports.isBounced || now >= row.claimBy) return false
    let to: string
    try {
      to = this.open(row, row.recipient.email, `imani-gift-tracker:${row.draftId}:recipient`)
    } catch {
      countGiftSweepError()
      return false
    }
    let bounced: boolean
    try {
      bounced = await this.ports.isBounced(to)
    } catch {
      countGiftSweepError()
      return false
    }
    if (!bounced) return false
    const sent = await this.send(row, 'gift-bounced', `${row.draftId}:bounced`, { recipient: to })
    if (sent === 'retry') return false
    // Refused (the buyer's own address suppressed, say): still no reminders to a dead address.
    row.bounced = now
    if (sent === 'sent') countGiftNotice('bounced')
    return sent === 'sent'
  }

  /**
   * §6c: the latest due reminder, if any. Only the offset closest to claimBy that is already due is
   * sent; any longer offset still unsent is passed over (never two at once, never a stale one).
   * True when a reminder went.
   */
  private async remind(row: TrackedGift, now: number, code?: { remaining: string }): Promise<boolean> {
    if (!row.recipient || row.unsubscribed !== undefined || row.bounced !== undefined || !this.ports.unsubscribeUrl) return false
    if (now >= row.claimBy - REMINDER_MARGIN_MS) return false
    const windowMs = row.claimBy - (row.trackedAt ?? 0)
    const offsets = (this.ports.reminderOffsetsMs ?? DEFAULT_REMINDER_OFFSETS_MS).filter((o) => o > 0 && o < windowMs)
    const due = offsets.filter((o) => now >= row.claimBy - o).sort((a, b) => a - b)
    if (due.length === 0) return false
    const latest = due[0]
    const done = row.reminders ?? {}
    // Already sent this one, or a later one (a shorter offset): nothing due.
    if (Object.keys(done).some((k) => Number(k) <= latest)) return false
    let to: string
    try {
      to = this.open(row, row.recipient.email, `imani-gift-tracker:${row.draftId}:recipient`)
    } catch {
      countGiftSweepError()
      return false
    }
    const url = this.ports.unsubscribeUrl(row.draftId, this.unsubscribeToken(row.draftId))
    const template = code ? 'gift-code-expiring' : 'gift-expiring'
    const fields: Record<string, string> = {
      ...(row.recipient.from ? { from: row.recipient.from } : {}),
      stall: row.stall,
      amount: row.amount,
      claimBy: displayDate(row.claimBy),
      sentOn: displayDate(row.trackedAt ?? now),
      sender: row.recipient.sender,
      claimSubject: row.recipient.claimSubject,
      ...(code ? { remaining: code.remaining } : {}),
    }
    let res: SendOutcome
    try {
      res = await this.ports.sendMail({ template, to, fields, idempotencyKey: `${row.draftId}:expiring:${latest}`, unsubscribeUrl: url })
    } catch {
      countGiftSweepError()
      return false
    }
    if (!res.ok && res.retryable) {
      countGiftSweepError()
      return false
    }
    // Sent, or refused for good (suppressed, say): either way this offset and every longer one are done.
    const marked = { ...done }
    for (const o of due) marked[String(o)] = now
    row.reminders = marked
    if (!res.ok) {
      countGiftSweepError()
      return false
    }
    countGiftNotice('expiring')
    return true
  }

  /**
   * #410: one code gift. `gift-code-used` each time the public check reports less remaining than
   * last seen (idempotency `<draftId>:code-used:<remaining>`), `gift-code-expired` once the code is
   * expired with something left on it (`<draftId>:code-expired`). True when the row is finished.
   */
  private async sweepCode(row: TrackedGift, now: number, out: { claimed: number; expired: number }): Promise<boolean> {
    const cg = row.codeGift
    if (!cg || !this.ports.checkCode) return false
    let code: string
    try {
      code = this.open(row, cg.code, `imani-gift-tracker:${row.draftId}:code`)
    } catch {
      countGiftSweepError()
      return true
    }
    let check: { status: string; remaining: number }
    try {
      check = await this.ports.checkCode(code)
    } catch {
      countGiftSweepError()
      return false
    }
    const money = (n: number) => formatMinor(n, cg.decimals, cg.unit)
    // The store reports 0 remaining once a code is expired: what came back is the last value seen.
    if (check.status === 'expired') {
      if (cg.lastRemaining > 0) this.observe(row, 'EXPIRED', cg.lastRemaining)
      if (cg.lastRemaining <= 0 || row.notified.expired !== undefined) return true
      const sent = await this.send(row, 'gift-code-expired', `${row.draftId}:code-expired`, {
        stall: row.stall,
        amount: row.amount,
        recipient: this.recipientName(row),
        expiresOn: displayDate(row.claimBy),
        remaining: money(cg.lastRemaining),
        returnMailDate: row.returnMailDate ?? displayDate(row.claimBy),
      })
      if (sent === 'retry') return false
      if (sent === 'sent') {
        row.notified.expired = now
        out.expired += 1
      }
      return true
    }
    // §6d for a code (flagged choice): remind only while nothing of it has been spent and it is not
    // mid-checkout, so a recipient who is already using it is not nagged.
    if (check.status === 'active' && check.remaining >= (cg.amountMinor ?? cg.lastRemaining) && now < row.claimBy) {
      await this.remind(row, now, { remaining: money(check.remaining) })
      return false
    }
    if (check.status === 'in_use' || check.remaining >= cg.lastRemaining) return false
    const spent = cg.lastRemaining - check.remaining
    const sent = await this.send(row, 'gift-code-used', `${row.draftId}:code-used:${check.remaining}`, {
      stall: row.stall,
      amount: row.amount,
      spent: money(spent),
      recipient: this.recipientName(row),
      expiresOn: displayDate(row.claimBy),
      ...(check.remaining > 0 ? { remaining: money(check.remaining) } : {}),
    })
    // Observed whatever the mail did: the spend happened.
    this.observe(row, check.remaining <= 0 ? 'CLAIMED' : 'PARTLY_USED', Math.max(0, check.remaining))
    if (sent === 'retry') return false
    cg.lastRemaining = check.remaining
    if (sent === 'sent') out.claimed += 1
    return check.remaining === 0
  }

  /** Record the latest outcome; a change (or a new balance) makes it due for delivery again. */
  private observe(row: TrackedGift, outcome: GiftOutcome, remainingMinor?: number): void {
    if (!this.ports.reportOutcome) return
    const prev = row.report
    if (prev && prev.outcome === outcome && prev.remainingMinor === remainingMinor) return
    row.report = { outcome, ...(remainingMinor !== undefined ? { remainingMinor } : {}) }
  }

  /** Deliver a due report. True when the row changed. Never throws. */
  private async deliverReport(row: TrackedGift | undefined): Promise<boolean> {
    if (!row?.report || row.report.sent || !this.ports.reportOutcome) return false
    let result: ReportResult
    try {
      result = await this.ports.reportOutcome(row.draftId, row.report.outcome, row.report.remainingMinor)
    } catch {
      result = 'retry'
    }
    if (result === 'retry') {
      countGiftSweepError()
      return false
    }
    // `gone`: payment-adapter will never take it (no such gift there). Stop asking.
    row.report.sent = true
    return true
  }

  /** What the buyer's notices call the recipient: the display, or the sealed address opened. */
  private recipientName(row: TrackedGift): string {
    if (row.recipientDisplay !== '' || !row.recipient) return row.recipientDisplay || 'the recipient'
    try {
      return this.open(row, row.recipient.email, `imani-gift-tracker:${row.draftId}:recipient`)
    } catch {
      return 'the recipient'
    }
  }

  private async send(row: TrackedGift, template: string, idempotencyKey: string, fields: Record<string, string>): Promise<'sent' | 'retry' | 'refused'> {
    let to: string
    try {
      to = this.open(row)
    } catch {
      countGiftSweepError()
      return 'refused'
    }
    let res: SendOutcome
    try {
      res = await this.ports.sendMail({ template, to, fields, idempotencyKey })
    } catch {
      countGiftSweepError()
      return 'retry'
    }
    if (res.ok) return 'sent'
    countGiftSweepError()
    return res.retryable ? 'retry' : 'refused'
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
            recipient: this.recipientName(row),
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
