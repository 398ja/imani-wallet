import type { VoucherRow } from '@imani/wallet-storage'

import { licenceIn } from './licences'
import { licenceSellerPubkey } from './licenceStatus'
import { signedFetch } from './nip98'
import { parseVoucherToken, proofSecrets } from './voucherToken'
import { listVouchers } from './wallet'

/**
 * Telling the server about this stall's licence (imani-wallet#197).
 *
 * The licence is a voucher held here, and until now it was checked only here, so no server knew a
 * stall had paid for extra terminals and every till but the free one was refused 402. The portal
 * now caches what gateway-customer verifies, and this is how it learns.
 *
 * ## What leaves the device: the proof SECRETS, never C
 *
 * A cashu proof is spent with its secret and its C (the mint's signature). The secret alone holds
 * everything the server checks (who issued it, who sold it, whose it is, until when) and gives the
 * Y the mint answers NUT-07 for. Without C nobody, the portal included, can spend it. So the body
 * is `{secrets}` and nothing else, and the request is NIP-98 signed by this account: the server
 * licenses only the SIGNER's stall, and only if the licence is locked to it.
 *
 * ## When
 *
 * Whenever the owner's wallet is looked at (the dashboard after login, the Terminals screen, and
 * whenever a new licence arrives by DM), at most once per `REPORT_INTERVAL_SECONDS` for the same
 * licence, and at once for a different one: a renewal is a new voucher, and reporting it straight
 * away is what keeps the extra tills selling across the old one's expiry. The server re-checks on
 * its own every 15 minutes, so this is a nudge rather than a heartbeat.
 *
 * ## Failure
 *
 * Never throws and never changes what the wallet shows. A report that fails is tried again on the
 * next look; the server keeps its last good answer meanwhile (decision 3).
 *
 * ## A licence the server refuses (review of #197, MEDIUM-3)
 *
 * Any stall can mint a licence-shaped voucher through the gateway and DM it to this account, and
 * DM'd vouchers are stored automatically. Reporting only the latest-expiring licence let such a
 * stranger's voucher shadow the genuine one for ever: refused 422, retried on every look, the
 * genuine licence never sent. So a 422 is a verdict on THAT voucher: it is remembered and never
 * sent again, and the next candidate by expiry is tried at once, up to `MAX_CANDIDATES` in one
 * report. A 503 or a network failure is not a verdict and stops there, remembering nothing.
 * With `VITE_LICENCE_SELLER_PUBKEY` set, a licence another stall sold is never a candidate.
 * Only `P2PK_VOUCHER` licences are candidates: the server refuses a plain VOUCHER.
 */

/** How long a successful report of the same licence stands before it is sent again. */
export const REPORT_INTERVAL_SECONDS = 6 * 60 * 60

const REPORTED_KEY_PREFIX = 'imani.licence.reported.'
const REFUSED_KEY_PREFIX = 'imani.licence.refused.'

/** How many licences one report tries before it gives up until the next look. */
export const MAX_CANDIDATES = 3

/** Remembered refusals per account, newest kept: a bound so a flood of fakes cannot grow storage. */
const MAX_REFUSED = 64

export type ReportOutcome = 'reported' | 'recent' | 'none' | 'failed'

export interface ReportOptions {
  /** This account: the stall, and the key the licence must be locked to. */
  pubkey: string
  /** Unix SECONDS. */
  now?: number
  loadRows?: () => Promise<VoucherRow[]>
  /** Overridable for tests. Defaults to a NIP-98 signed POST to the portal. */
  post?: (body: { secrets: string[] }) => Promise<{ status: number }>
  /** The licence seller to pin. Defaults to `licenceSellerPubkey()`; empty does not pin. */
  sellerPublicKey?: string
}

interface Reported {
  voucherId: string
  at: number
}

function reportedKey(pubkey: string): string {
  return `${REPORTED_KEY_PREFIX}${pubkey}`
}

function readReported(pubkey: string): Reported | null {
  try {
    const raw = localStorage.getItem(reportedKey(pubkey))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Reported>
    if (typeof parsed.voucherId !== 'string' || typeof parsed.at !== 'number') return null
    return { voucherId: parsed.voucherId, at: parsed.at }
  } catch {
    return null
  }
}

function writeReported(pubkey: string, reported: Reported): void {
  try {
    localStorage.setItem(reportedKey(pubkey), JSON.stringify(reported))
  } catch {
    // No note means the next look reports again. Harmless.
  }
}

function readRefused(pubkey: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${REFUSED_KEY_PREFIX}${pubkey}`) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function rememberRefused(pubkey: string, voucherId: string): void {
  try {
    const refused = readRefused(pubkey).filter((id) => id !== voucherId)
    refused.push(voucherId)
    localStorage.setItem(`${REFUSED_KEY_PREFIX}${pubkey}`, JSON.stringify(refused.slice(-MAX_REFUSED)))
  } catch {
    // Not remembered: the next look tries it again and is refused again. Harmless.
  }
}

/** Forget when this account last reported, and what was refused. For tests, and for a wipe. */
export function forgetLicenceReport(pubkey: string): void {
  try {
    localStorage.removeItem(reportedKey(pubkey))
    localStorage.removeItem(`${REFUSED_KEY_PREFIX}${pubkey}`)
  } catch {
    // Nothing to clear.
  }
}

async function postToPortal(body: { secrets: string[] }): Promise<{ status: number }> {
  const response = await signedFetch('/api/v1/portal/licence', 'POST', body)
  return { status: response.status }
}

function sameKey(a: string | undefined, b: string): boolean {
  return !!a && a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Report this account's current licence to the server, if it holds one.
 *
 * Picks the licence locked to this account that expires last and has not expired. Whether it is
 * genuine is the server's question, not this one's: the server verifies the issuer, the seller and
 * the mint state, and refuses anything else.
 */
export async function reportLicence(options: ReportOptions): Promise<ReportOutcome> {
  // One report at a time per account: the dashboard and the Terminals screen both ask when they
  // load, and two posts of one licence are one too many (seen on the local gate).
  const key = options.pubkey.toLowerCase()
  const running = inFlight.get(key)
  if (running) return running
  const attempt = reportOnce(options).finally(() => inFlight.delete(key))
  inFlight.set(key, attempt)
  return attempt
}

const inFlight = new Map<string, Promise<ReportOutcome>>()

async function reportOnce(options: ReportOptions): Promise<ReportOutcome> {
  // nosemgrep: imani-caller-supplied-clock
  // CLIENT-side and app-built: only decides whether to send, the server decides with its own clock.
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const load = options.loadRows ?? listVouchers
  const post = options.post ?? postToPortal

  let rows: VoucherRow[]
  try {
    rows = await load()
  } catch {
    return 'failed'
  }

  const seller = (options.sellerPublicKey ?? licenceSellerPubkey()).trim().toLowerCase()
  const refused = new Set(readRefused(options.pubkey))
  const candidates: Array<{ voucherId: string; secrets: string[]; expiresAt: number }> = []
  // EVERY held licence row, not one per subscription (heldLicences): a stranger's voucher that
  // copies this account's subscription_id with a later expiry must not hide the genuine one.
  for (const row of rows) {
    const licence = licenceIn(row)
    if (!licence) continue
    if (!licence.mintLockKey) continue
    if (seller && !sameKey(licence.issuerId, seller)) continue
    if (!sameKey(licence.lockKey, options.pubkey)) continue
    if (typeof licence.expiresAt !== 'number' || licence.expiresAt <= now) continue
    let voucherId: string
    let secrets: string[]
    try {
      voucherId = parseVoucherToken(row.token).voucher.voucherId
      secrets = proofSecrets(row.token)
    } catch {
      continue
    }
    if (secrets.length === 0 || refused.has(voucherId)) continue
    if (candidates.some((c) => c.voucherId === voucherId)) continue
    candidates.push({ voucherId, secrets, expiresAt: licence.expiresAt })
  }
  if (candidates.length === 0) return refused.size > 0 ? 'failed' : 'none'
  // Latest expiry first: the one that licenses longest is the one worth the server's answer.
  candidates.sort((a, b) => b.expiresAt - a.expiresAt)

  const last = readReported(options.pubkey)
  if (last && last.voucherId === candidates[0].voucherId && now - last.at < REPORT_INTERVAL_SECONDS) {
    return 'recent'
  }

  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    let status: number
    try {
      status = (await post({ secrets: candidate.secrets })).status
    } catch {
      return 'failed'
    }
    if (status >= 200 && status < 300) {
      writeReported(options.pubkey, { voucherId: candidate.voucherId, at: now })
      return 'reported'
    }
    if (status !== 422) {
      // An outage or a spent licence (409) says nothing about the next candidate's chances in a
      // way worth spending a request on now: the next look tries again.
      return 'failed'
    }
    console.warn('[licence] the server refused a held licence; trying the next one', candidate.voucherId)
    rememberRefused(options.pubkey, candidate.voucherId)
  }
  return 'failed'
}
