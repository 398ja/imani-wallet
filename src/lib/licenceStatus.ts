import {
  decideWithGrace,
  verifyLicence,
  GRACE_REASONS,
  type LastVerification,
  type LicenceCheck,
  type LicenceDecision,
  type LicenceVoucher,
} from '@imani/licence'
import type { VoucherRow } from '@imani/wallet-storage'

import { heldLicences, licenceSignatureVerifier } from './licences'
import { listVouchers } from './wallet'

/**
 * What this device currently believes about its subscription.
 *
 * The three pieces built so far do not touch each other: `@imani/licence`
 * decides but reads nothing, `licences.ts` recognises but does not verify, and
 * the wallet store holds rows that know nothing about either. This module is
 * the join, and it is the only place that knows all three exist.
 *
 * ## Why the join is its own module
 *
 * The decision needs four things that come from four different places: the
 * voucher (the store), our issuer key (deployment config), the clock (the
 * device), and the last successful verification (persisted here). A screen that
 * gathered those itself would be a screen with the licence rules inside it, and
 * the second caller — the enrolment gate, ticket 07 — would gather them again
 * and get subtly different answers. One asks "may I?", and this answers.
 *
 * ## The persistence is the grace window's memory
 *
 * `decideWithGrace` is pure: it takes the last verification and returns a
 * decision, but it cannot remember anything. Something has to write down "we
 * verified successfully at T", and it has to survive a reload or the window
 * resets every time the app starts — which would mean a merchant who restarts
 * their app during an outage loses the window ADR 0007 promises them.
 *
 * It is written ONLY on a successful answer. Recording failures too would let a
 * device that has never held a licence accumulate a history, and the window is
 * credit earned rather than time passed.
 */

/** Where the last successful verification is remembered, per account. */
const VERIFIED_KEY_PREFIX = 'imani.licence.verified.'

/**
 * OUR issuer public key: the one key a licence must be signed by.
 *
 * A build-time value rather than something read from the gateway, and that is a
 * security decision rather than a convenience. `GET /api/v1/config` is fetched
 * over the network from a host the app trusts for domain names and media URLs;
 * trusting it for the licence issuer key would mean anyone who can answer that
 * request can mint their own subscriptions. The key is ours, it changes on the
 * timescale of years, and it belongs in the bundle.
 *
 * Empty means NO LICENCE VERIFIES. `verifyLicence` refuses to default its issuer
 * key for exactly this reason, and defaulting it here would reintroduce the hole
 * one layer up. A deployment that has not set `VITE_LICENCE_ISSUER_PUBKEY`
 * grants nothing, which is the safe direction: the feature is off rather than
 * open.
 *
 * Read through a FUNCTION rather than captured in a module constant. A constant
 * is fixed at import, which makes the one security-critical input in this file
 * the one input a test cannot vary — and an untestable gate is how a
 * misconfigured deployment ships open.
 */
export function licenceIssuerPubkey(): string {
  return (import.meta.env.VITE_LICENCE_ISSUER_PUBKEY as string | undefined) ?? ''
}

/** Unix SECONDS, matching every clock in `@imani/licence`. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function verifiedKey(pubkey: string): string {
  return `${VERIFIED_KEY_PREFIX}${pubkey}`
}

/**
 * The last successful verification this device recorded, or null.
 *
 * Anything unreadable, unparseable or structurally wrong reads as null — "never
 * verified" — rather than throwing. That is the strict direction: a corrupted
 * record gives no window, where a lenient parse could hand out a grant whose
 * features came from garbage.
 */
export function readLastVerification(pubkey: string): LastVerification | null {
  try {
    const raw = localStorage.getItem(verifiedKey(pubkey))
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<LastVerification>
    const at = parsed.at
    const grant = parsed.grant
    if (typeof at !== 'number' || !Number.isFinite(at)) return null
    if (!grant || typeof grant.expiresAt !== 'number') return null
    if (!Array.isArray(grant.features)) return null

    return {
      at,
      grant: {
        features: grant.features.filter((f): f is string => typeof f === 'string'),
        subscriptionId: grant.subscriptionId,
        expiresAt: grant.expiresAt,
        pilot: grant.pilot === true,
      },
    }
  } catch {
    return null
  }
}

/**
 * Remember that a check answered YES, just now.
 *
 * Storage failures are swallowed on purpose. A merchant in a private-browsing
 * mode, or with a full quota, must not be refused their subscription because we
 * could not write a note about it — they simply get no grace window, which is
 * the same position as a device that has never been offline.
 */
function rememberVerification(pubkey: string, verification: LastVerification): void {
  try {
    localStorage.setItem(verifiedKey(pubkey), JSON.stringify(verification))
  } catch {
    // Degraded to "no window", never to "no licence".
  }
}

/** Forget the window. For tests, and for a wipe. */
export function forgetVerification(pubkey: string): void {
  try {
    localStorage.removeItem(verifiedKey(pubkey))
  } catch {
    // Nothing to do: the caller is clearing state that may not exist.
  }
}

/** Everything the screen needs to explain itself, not merely to gate. */
export interface LicenceStatus {
  decision: LicenceDecision
  /**
   * The licence the decision was made about, when one was found.
   *
   * Present even when the decision REFUSED, because that is the case a support
   * conversation is about: "expired on the 3rd" needs the voucher that expired.
   */
  licence: LicenceVoucher | null
  /** When the check ran, so a screen can say what it is describing. */
  checkedAt: number
}

export interface LicenceStatusOptions {
  /** The key presenting the licence — this device's account. */
  pubkey: string
  /** Overridable so a test can move the clock instead of waiting. */
  now?: number
  /** Overridable so a test need not populate the real wallet store. */
  loadRows?: () => Promise<VoucherRow[]>
  /** Overridable so a test can pin a deployment key. */
  issuerPublicKey?: string
}

/**
 * Ask what this device is entitled to, right now.
 *
 * The order is the whole of the composition:
 *
 * 1. **Load the held licences.** A failure here is an OUTAGE, not an answer —
 *    storage being unavailable says nothing about whether the customer paid.
 * 2. **Verify the current one**, against our issuer key, this device's key and
 *    the clock. An answer, either way, is signed.
 * 3. **Apply the window** to whichever of those two happened.
 * 4. **Remember a success**, so the window has something to run from.
 *
 * Step 1's failure mode is the one worth stating: `{ status: 'impossible' }`
 * rather than a refusal. A store that will not open is precisely the outage ADR
 * 0007 says must not take a paying merchant's features away, and reporting it
 * as "no licence" would do exactly that.
 */
export async function licenceStatus(options: LicenceStatusOptions): Promise<LicenceStatus> {
  const now = options.now ?? nowSeconds()
  const issuerPublicKey = options.issuerPublicKey ?? licenceIssuerPubkey()
  const load = options.loadRows ?? listVouchers

  let held: ReturnType<typeof heldLicences> = []
  let check: LicenceCheck
  let licence: LicenceVoucher | null = null

  try {
    held = heldLicences(await load())
  } catch (error) {
    // Could not look. Not "no licence" — see above.
    return {
      decision: decideWithGrace({
        check: {
          status: 'impossible',
          detail: `the wallet could not be read (${describe(error)})`,
        },
        lastVerification: readLastVerification(options.pubkey),
        now,
      }),
      licence: null,
      checkedAt: now,
    }
  }

  if (held.length === 0) {
    // No licence delivered yet. This IS an answer — the store was readable and
    // held none — so `verifyLicence` reports ABSENT and no window applies. A
    // fresh install with no subscription must not get a grace period.
    check = { status: 'answered', verdict: verifyLicence(null, {
      issuerPublicKey,
      now,
      presenter: options.pubkey,
      verifySignature: () => false,
    }) }
  } else {
    /**
     * The newest licence per subscription, and if a stall somehow holds two
     * SUBSCRIPTIONS, the one expiring last. That cannot happen from anything we
     * sell — one feature, one licence — but a customer could be re-issued onto
     * a new id by support, and picking the one that grants longest is the
     * reading that never takes something away from someone who paid.
     */
    const best = held.reduce((a, b) =>
      (b.licence.expiresAt ?? -Infinity) > (a.licence.expiresAt ?? -Infinity) ? b : a,
    )
    licence = best.licence

    check = {
      status: 'answered',
      verdict: verifyLicence(best.licence, {
        issuerPublicKey,
        now,
        presenter: options.pubkey,
        // Bound to the ROW the licence came from: the verifier re-parses that
        // exact token, so a licence cannot be checked against another's bytes.
        verifySignature: licenceSignatureVerifier(best.row),
      }),
    }
  }

  const decision = decideWithGrace({
    check,
    lastVerification: readLastVerification(options.pubkey),
    now,
  })

  // Only a fresh, verified answer earns a window. A decision carried BY the
  // window must not renew it — that would make an offline device's window
  // roll forward forever, which is the one thing rule 2 of `decideWithGrace`
  // exists to prevent.
  if (decision.granted && decision.source === 'verified') {
    rememberVerification(options.pubkey, { at: now, grant: decision.grant })
  }

  return { decision, licence, checkedAt: now }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Does this device currently hold the named feature? */
export function grants(status: LicenceStatus, feature: string): boolean {
  return status.decision.granted && status.decision.grant.features.includes(feature)
}

/**
 * Why the licence is in the state it is, in words a support conversation uses.
 *
 * Every reason the two modules can produce is named here, and the phrasing is
 * the point of the ticket: "The screen names what it believes and why, in terms
 * that answer a support question rather than only a developer's."
 *
 * The mapping is exhaustive rather than defaulted, so a reason added later
 * without a sentence here is a TypeScript error rather than a customer reading
 * `grace-elapsed` on their till.
 */
export function explain(status: LicenceStatus): string {
  const { decision } = status

  if (decision.granted) {
    if (decision.source === 'grace') {
      return (
        'Working, but we have not been able to confirm this subscription recently. ' +
        'It will keep working until the connection returns or the grace period ends.'
      )
    }
    return 'This subscription is active and was confirmed just now.'
  }

  switch (decision.reason) {
    case 'absent':
      return 'No subscription has arrived on this device yet.'
    case 'wrong-issuer':
      return 'This licence was not issued by us, so it grants nothing.'
    case 'bad-signature':
      return 'This licence has been altered since it was issued, so it cannot be trusted.'
    case 'wrong-key':
      return 'This licence belongs to a different device or account.'
    case 'unlocked':
      return 'This licence is not tied to a key, so it cannot be used by anyone.'
    case 'expired':
      return 'This subscription has ended. Renewing restores it immediately.'
    case 'no-expiry':
      return 'This licence carries no end date, which is not something we issue.'
    case 'no-features':
      return 'This licence unlocks nothing. Support will need to re-issue it.'
    case GRACE_REASONS.NEVER_VERIFIED:
      return (
        'We have never been able to confirm a subscription on this device, ' +
        'so there is nothing to fall back on while offline.'
      )
    case GRACE_REASONS.GRACE_ELAPSED:
      return (
        'We have not been able to confirm this subscription for too long. ' +
        'It will come back as soon as the device can check again.'
      )
  }
}
