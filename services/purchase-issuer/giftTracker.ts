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
  codeGift?: { code: { iv: string; sealed: string }; decimals: number; unit: string; lastRemaining: number }
  /**
   * Business metrics: the latest outcome seen for this gift, until payment-adapter has it
   * (`sent`). payment-adapter owns every gift state; this tracker only reports what it alone sees.
   */
  report?: { outcome: GiftOutcome; remainingMinor?: number; sent?: boolean }
  /** The sweep is done with this row and keeps it only until its report is delivered. */
  finished?: boolean
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
      recipientDisplay: input.recipientDisplay,
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
            },
          }
        : {}),
      notified: {},
    }
    return this.serial(async () => {
      const rows = await this.store.read()
      // A re-drive of the same draft keeps what was already notified.
      const prior = rows[input.draftId]
      rows[input.draftId] = prior
        ? { ...row, notified: prior.notified, ...(prior.codeGift && row.codeGift ? { codeGift: { ...row.codeGift, lastRemaining: prior.codeGift.lastRemaining } } : {}) }
        : row
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
      // A finished row is kept only until payment-adapter has its outcome.
      const finish = (id: string) => {
        const row = rows[id]
        if (row?.report && !row.report.sent && this.ports.reportOutcome) row.finished = true
        else delete rows[id]
        out.dropped += 1
      }
      for (const [id, row] of Object.entries(rows)) {
        if (row.report && !row.report.sent && this.ports.reportOutcome) {
          if (await this.deliverReport(row)) changed = true
          if (row.finished && row.report.sent) {
            delete rows[id]
            changed = true
            continue
          }
        }
        if (row.finished) {
          // Undeliverable for the whole keep window: give up, payment-adapter keeps its last state.
          if (now >= row.claimBy + KEEP_AFTER_CLAIM_BY_MS) {
            delete rows[id]
            changed = true
          }
          continue
        }
        if (now >= row.claimBy + KEEP_AFTER_CLAIM_BY_MS) {
          delete rows[id]
          out.dropped += 1
          changed = true
          continue
        }
        if (row.checkedAt !== undefined && now - row.checkedAt < (this.ports.sweepEveryMs ?? SWEEP_EVERY_MS)) continue
        row.checkedAt = now
        changed = true
        if (row.kind === 'code') {
          const done = await this.sweepCode(row, now, out)
          if (done) finish(id)
          if (await this.deliverReport(rows[id])) changed = true
          if (rows[id]?.finished && rows[id].report?.sent) delete rows[id]
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
          if (!allSpent) continue
          this.observe(row, 'CLAIMED')
          const sent = await this.notify(row, 'claimed')
          if (sent !== 'retry') {
            if (sent === 'sent') out.claimed += 1
            finish(id)
          }
          if (await this.deliverReport(rows[id])) changed = true
          if (rows[id]?.finished && rows[id].report?.sent) delete rows[id]
          continue
        }
        if (anySpent) {
          this.observe(row, 'RETURNED')
          finish(id)
          if (await this.deliverReport(rows[id])) changed = true
          if (rows[id]?.finished && rows[id].report?.sent) delete rows[id]
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
            finish(id)
          }
        }
      }
      if (changed) await this.store.write(rows)
      return out
    })
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
        recipient: row.recipientDisplay,
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
    if (check.status === 'in_use' || check.remaining >= cg.lastRemaining) return false
    const spent = cg.lastRemaining - check.remaining
    const sent = await this.send(row, 'gift-code-used', `${row.draftId}:code-used:${check.remaining}`, {
      stall: row.stall,
      amount: row.amount,
      spent: money(spent),
      recipient: row.recipientDisplay,
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
