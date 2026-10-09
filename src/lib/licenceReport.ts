import type { VoucherRow } from '@imani/wallet-storage'

import { heldLicences } from './licences'
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
 */

/** How long a successful report of the same licence stands before it is sent again. */
export const REPORT_INTERVAL_SECONDS = 6 * 60 * 60

const REPORTED_KEY_PREFIX = 'imani.licence.reported.'

export type ReportOutcome = 'reported' | 'recent' | 'none' | 'failed'

export interface ReportOptions {
  /** This account: the stall, and the key the licence must be locked to. */
  pubkey: string
  /** Unix SECONDS. */
  now?: number
  loadRows?: () => Promise<VoucherRow[]>
  /** Overridable for tests. Defaults to a NIP-98 signed POST to the portal. */
  post?: (body: { secrets: string[] }) => Promise<{ status: number }>
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

/** Forget when this account last reported. For tests, and for a wipe. */
export function forgetLicenceReport(pubkey: string): void {
  try {
    localStorage.removeItem(reportedKey(pubkey))
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

  const candidates = heldLicences(rows).filter(
    ({ licence }) =>
      sameKey(licence.lockKey, options.pubkey) &&
      typeof licence.expiresAt === 'number' &&
      licence.expiresAt > now,
  )
  if (candidates.length === 0) return 'none'
  const best = candidates.reduce((a, b) =>
    (b.licence.expiresAt ?? 0) > (a.licence.expiresAt ?? 0) ? b : a,
  )

  let voucherId: string
  let secrets: string[]
  try {
    voucherId = parseVoucherToken(best.row.token).voucher.voucherId
    secrets = proofSecrets(best.row.token)
  } catch {
    return 'failed'
  }
  if (secrets.length === 0) return 'failed'

  const last = readReported(options.pubkey)
  if (last && last.voucherId === voucherId && now - last.at < REPORT_INTERVAL_SECONDS) {
    return 'recent'
  }

  try {
    const { status } = await post({ secrets })
    if (status < 200 || status >= 300) return 'failed'
  } catch {
    return 'failed'
  }
  writeReported(options.pubkey, { voucherId, at: now })
  return 'reported'
}
