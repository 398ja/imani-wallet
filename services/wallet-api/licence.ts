import {
  verifyLicence,
  decideWithGrace,
  licenceOf,
  type LicenceVoucher,
  type LastVerification,
} from '@imani/licence'


import { parseVoucherToken, verifyVoucher } from '../../src/lib/voucherToken.js'

/**
 * What a licence entitles its holder to.
 *
 * API ticket 09. An attest: the caller sends the licence it holds and gets a
 * verdict. There is no lookup of who they are, and there must not be — ADR 0007
 * decides a licence is a voucher we sold, verified OFFLINE, with no licence
 * server and no honeypot of who-runs-what. An endpoint that quietly became one
 * would undo that.
 *
 * ## Why this is worth an endpoint at all
 *
 * So an automation can ask "is this feature available to me?" BEFORE it tries.
 * The alternative is discovering a lapse through a failure in the middle of a
 * workflow, which is the worst moment to find out.
 *
 * ## A licence is never money
 *
 * It carries a face value like any voucher. Nothing here reports it as a
 * balance, and `/v1/holding/value` must never sum one — the same rule the app
 * follows.
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; error: { field: string; detail: string } }

const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { field, detail } })

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}

const HEX64 = /^[0-9a-f]{64}$/i

/**
 * OUR issuer key, with no default.
 *
 * `verifyLicence` refuses to default this and says why: a default would be a
 * licence check that passes for a voucher anyone minted, which is the one
 * failure the module exists to prevent. The endpoint answers 503 rather than
 * inventing one, because a licence check nobody configured is worse than no
 * licence check — it looks like it is working.
 */
export function licenceIssuerPubkey(): string | null {
  const configured = process.env.WALLET_API_LICENCE_ISSUER_PUBKEY ?? ''
  return HEX64.test(configured) ? configured.toLowerCase() : null
}

export interface LicenceStatusInput {
  token: string
  /** The key presenting it — the licence must be locked to this. */
  presenter: string
  /** Unix SECONDS, supplied so expiry is testable to the second. */
  now: number
  lastVerification?: LastVerification
}

export function parseLicenceRequest(
  body: unknown,
  callerPubkey: string,
  defaultNow: number,
): Parsed<LicenceStatusInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', `expected a JSON object, got ${describe(body)}`)
  }
  const b = body as Record<string, unknown>

  const token = typeof b.token === 'string' ? b.token.trim() : ''
  if (!token) return fail('token', 'required — the licence voucher to check')

  const now = Number(b.now ?? defaultNow)
  if (!Number.isFinite(now)) return fail('now', 'expected unix SECONDS')

  /**
   * The presenter is the SIGNING key.
   *
   * A licence is locked to a key, and the holder must prove they have it. Over
   * HTTP the proof is the NIP-98 signature, so reading a presenter from the
   * body would let anyone check — and pass — with a licence they merely copied.
   */
  if (b.presenter !== undefined && String(b.presenter).toLowerCase() !== callerPubkey.toLowerCase()) {
    return fail(
      'presenter',
      'a licence is checked against the SIGNING key — the signature is what proves the holder has it',
    )
  }

  const lastRaw = b.lastVerification
  let lastVerification: LastVerification | undefined
  if (lastRaw !== undefined) {
    if (lastRaw === null || typeof lastRaw !== 'object' || Array.isArray(lastRaw)) {
      return fail('lastVerification', `expected an object, got ${describe(lastRaw)}`)
    }
    const l = lastRaw as Record<string, unknown>
    const at = Number(l.at)
    if (!Number.isFinite(at)) return fail('lastVerification.at', 'expected unix SECONDS')

    // The window carries the GRANT it last saw, not a boolean. A device coming
    // out of an outage keeps the features it was actually entitled to rather
    // than a blanket yes.
    const grant = l.grant
    if (grant === null || typeof grant !== 'object' || Array.isArray(grant)) {
      return fail('lastVerification.grant', `expected the grant last seen, got ${describe(grant)}`)
    }
    const g = grant as Record<string, unknown>
    const expiresAt = Number(g.expiresAt)
    if (!Number.isFinite(expiresAt)) {
      return fail('lastVerification.grant.expiresAt', 'expected unix SECONDS')
    }
    lastVerification = {
      at,
      grant: {
        features: Array.isArray(g.features) ? g.features.map(String) : [],
        subscriptionId: typeof g.subscriptionId === 'string' ? g.subscriptionId : undefined,
        expiresAt,
        pilot: g.pilot === true,
      },
    }
  }

  return { ok: true, value: { token, presenter: callerPubkey, now, lastVerification } }
}

export interface LicenceVerdictResponse {
  granted: boolean
  reason?: string
  detail?: string
  /**
   * Where the answer came from: a fresh verification, or the grace window.
   *
   * Surfaced so a caller can tell "your licence is good" from "we could not
   * check and are trusting a recent yes", which are different things to act on.
   */
  source?: string
  /** What this licence actually unlocks. Empty is different from absent. */
  features?: string[]
  licence?: {
    subscriptionId?: string
    expiresAt?: number
    /** Seconds until it lapses. Negative once it has. */
    expiresIn?: number
  }
}

/**
 * Check a licence, entirely locally.
 *
 * No network, no store. The caller sends the voucher; we read it, verify our
 * signature over it, check the lock and the expiry, and say what it grants.
 */
export function checkLicence(
  input: LicenceStatusInput,
  issuerPublicKey: string,
): LicenceVerdictResponse {
  /**
   * Read the licence out of the token, and verify OUR signature over it.
   *
   * `licenceOf` comes from `@imani/licence`, not from `src/lib/licences.ts`.
   * That module type-imports `VoucherRow` from `@imani/wallet-storage`, and
   * TypeScript loads the whole module even for a type-only import — reaching
   * `IDBDatabase`, a browser global a Node project has no types for. Fifteen
   * typecheck errors arrived that way, which is what moved the reader into the
   * package where both callers can use it.
   */
  let voucher: LicenceVoucher | null = null
  let signatureValid = false
  try {
    const parsed = parseVoucherToken(input.token)
    voucher = licenceOf(parsed.voucher)
    signatureValid = verifyVoucher(parsed.voucher).signatureValid
  } catch {
    // Not a voucher token at all. `verifyLicence` reports that as ABSENT, which
    // is the honest answer: nothing was presented that could grant anything.
  }

  const verdict = verifyLicence(voucher, {
    issuerPublicKey,
    now: input.now,
    presenter: input.presenter,
    // Injected because canonicalisation belongs to the voucher format and the
    // DECISION belongs to the package. Already computed above, from the same
    // parse.
    verifySignature: () => signatureValid,
  })

  const licence = voucher
    ? {
        subscriptionId: voucher.subscriptionId,
        expiresAt: voucher.expiresAt,
        expiresIn:
          typeof voucher.expiresAt === 'number' ? voucher.expiresAt - input.now : undefined,
      }
    : undefined

  /**
   * An ANSWERED check is obeyed, whichever way it went.
   *
   * The grace window exists for an OUTAGE — a check that could not run at all —
   * and passing an answered denial through it would soften every expiry into a
   * free month. `LicenceCheck`'s own doc draws exactly this line: "an EXPIRED
   * voucher arrives here, not below: we asked and it said no."
   *
   * This endpoint always reaches an answer, because everything it needs came in
   * the request. So there is no outage to survive, and `decideWithGrace` is
   * called with the answered check for one reason only: to keep this service's
   * verdict identical to the app's rather than reimplementing the rule.
   */
  const decision = decideWithGrace({
    check: { status: 'answered', verdict },
    lastVerification: input.lastVerification ?? null,
    now: input.now,
  })

  return {
    granted: decision.granted,
    reason: verdict.granted ? undefined : verdict.reason,
    detail: verdict.granted ? undefined : verdict.detail,
    // Only a granted decision carries a source, and only a granted one has
    // anything to say about where the answer came from.
    source: decision.granted ? decision.source : undefined,
    features: decision.granted ? [...decision.grant.features] : undefined,
    licence,
  }
}
