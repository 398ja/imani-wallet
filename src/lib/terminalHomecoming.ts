import { parseIssuanceWarrant } from './issuanceWarrant'
import { parseCredentialSecret } from './terminalWarrant'
import { allTerminals } from './terminalRoster'
import { rosterSyncedOnce } from './terminalRosterSync'
import { recordNotification } from './notifications/inbox'

/**
 * The home-coming roster check (#160 phase 6, plan 2.5, decision 5 Q2).
 *
 * A till's sale carries a `terminal` warrant naming the credential it sold under. When that
 * coupon comes home to the stall (redeemed at the stall, or filed from a till's sale record), the
 * credential must be one the owner's roster knows, under ANY status: current, renewed away or
 * revoked. One it has never seen means a stall-attested credential exists that the owner's list
 * does not hold, so the owner is told.
 *
 * It never refuses: the customer paid, and the warrant already verified (the stall's own
 * attestation included). It only raises an alert. And it stays quiet until this device has
 * merged the published roster at least once, so a fresh restore cannot false-alarm.
 */

export const HOMECOMING_ALERT =
  'A coupon came back from a till that is not on your list. If you did not set it up, contact support.'

export type HomecomingVerdict = 'ok' | 'unknown-till' | 'not-synced' | 'not-a-till-sale'

/** The credential voucher id a `terminal` warrant carries, or null for any other warrant. */
export function credentialOfWarrant(raw: string | undefined | null): string | null {
  const warrant = parseIssuanceWarrant(raw)
  if (warrant.state !== 'present' || warrant.form !== 'terminal') return null
  const credential = parseCredentialSecret(warrant.credential)
  const row = credential?.rows.find((r) => r[0] === 'voucher_id')
  return row && typeof row[1] === 'string' ? row[1] : null
}

/** Every credential voucher id this stall's roster has ever held. */
function knownCredentials(stallPubkey: string): Set<string> {
  const known = new Set<string>()
  for (const row of allTerminals(stallPubkey)) {
    if (row.voucherId) known.add(row.voucherId)
    if (row.renewal?.voucherId) known.add(row.renewal.voucherId)
    for (const c of row.credentials ?? []) known.add(c.voucherId)
  }
  return known
}

export function homecomingCheck(stallPubkey: string, warrant: string | undefined | null): HomecomingVerdict {
  const credential = credentialOfWarrant(warrant)
  if (!credential) return 'not-a-till-sale'
  if (!rosterSyncedOnce(stallPubkey)) return 'not-synced'
  return knownCredentials(stallPubkey).has(credential) ? 'ok' : 'unknown-till'
}

/** Read the published roster into this device again. True when it was read. */
export type RosterRefresh = (stallPubkey: string) => Promise<boolean>

const syncFromNetwork: RosterRefresh = (stall) =>
  import('./terminalRosterSyncNet').then((m) => m.syncRosterNow(stall))

/**
 * Check a home-coming coupon and, for one from a till the list never had, record the alert in
 * the owner's notification bell. Once per credential, however many of its coupons come home.
 * Never refuses and never throws.
 *
 * A credential this device does not know is checked again after reading the published roster:
 * this phone's copy may predate a till the owner set up or renewed on another phone (found by
 * the local gate, #160 phase 6). Only a credential the published list does not have either is
 * alerted on.
 */
export async function raiseHomecomingAlert(
  stallPubkey: string,
  warrant: string | undefined | null,
  couponId: string,
  refresh: RosterRefresh = syncFromNetwork,
): Promise<HomecomingVerdict> {
  try {
    let verdict = homecomingCheck(stallPubkey, warrant)
    if (verdict !== 'unknown-till') return verdict
    if (await refresh(stallPubkey).catch(() => false)) {
      verdict = homecomingCheck(stallPubkey, warrant)
      if (verdict !== 'unknown-till') return verdict
    }
    const credential = credentialOfWarrant(warrant)
    recordNotification(stallPubkey, {
      id: `homecoming:${credential}`,
      type: 'generic',
      title: 'A till not on your list',
      body: HOMECOMING_ALERT,
      url: '/settings/terminals',
    })
    console.warn('[homecoming] coupon from a till not on the roster', { couponId, credential })
    return verdict
  } catch {
    return 'not-a-till-sale'
  }
}
