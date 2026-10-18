/**
 * Putting this service's stall credentials in service at the gateway, EAGERLY (imani-wallet#296).
 *
 * gateway-customer keeps a minted terminal credential confirmable for 24 hours, then lapses it
 * (`PENDING_TTL`, gc 0.31.0). This service used to confirm lazily, the first time a card sale read
 * the credential, so a stall enrolled more than a day before its first sale was silently dead:
 * confirm 410, mint 403, and the paid purchase BLOCKED as "credential burnt or replaced".
 *
 * Now a credential is confirmed when it is written to the vault (`attachDelegation.ts`) and, for
 * every record, when the service starts. One that has expired is logged loudly, counted in
 * `imani_purchase_issuer_credentials{standing}`, and marked, so its sales stay owed with the real
 * reason (re-enrol) rather than blocked on a wrong one.
 *
 * ## One confirm in flight per credential
 *
 * Two sales for one stall in the same pass used to send two confirms, and the second carried the
 * identical signed NIP-98 event, which the gateway refused as a replay (401). Concurrent callers
 * now share one request, and every new attempt is signed afresh (`authorization` adds a nonce).
 */
import { confirmStanding, type ConfirmStanding } from './adapters'
import type { StallCredential } from './issuer'
import { setCredentialStandings } from './metrics'
import type { CredentialVault } from './vault'

/** The reason a sale for an expired credential reports. Names the fix, not a guess. */
export const EXPIRED_REASON =
  'the stall’s purchase-issuer credential expired unconfirmed at the gateway (410); ' +
  're-enrol the purchase issuer for this stall. Nothing minted; the purchase stays owed'

export class CredentialConfirmer {
  private readonly standings = new Map<string, ConfirmStanding>()
  private readonly inFlight = new Map<string, Promise<ConfirmStanding>>()

  private readonly gatewayUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(gatewayUrl: string, fetchImpl: typeof fetch = fetch) {
    this.gatewayUrl = gatewayUrl
    this.fetchImpl = fetchImpl
  }

  /**
   * Confirm unless already known. `confirmed` and `expired` are final for a credential id, so
   * neither is asked again. `unconfirmed` (a transient failure) is retried on the next call.
   */
  async confirm(credential: StallCredential): Promise<ConfirmStanding> {
    const id = credential.credentialId
    const known = this.standings.get(id)
    if (known === 'confirmed' || known === 'expired') return known
    const pending = this.inFlight.get(id)
    if (pending) return pending
    const attempt = confirmStanding(this.gatewayUrl, credential, this.fetchImpl)
      .then((standing) => {
        this.standings.set(id, standing)
        this.publish()
        return standing
      })
      .finally(() => this.inFlight.delete(id))
    this.inFlight.set(id, attempt)
    return attempt
  }

  /** The credential, marked unusable if it can never be confirmed. Confirms first when needed. */
  async annotate(credential: StallCredential): Promise<StallCredential> {
    const standing = await this.confirm(credential)
    return standing === 'expired' ? { ...credential, unusable: EXPIRED_REASON } : credential
  }

  private publish(): void {
    const counts = { confirmed: 0, expired: 0, unconfirmed: 0 }
    for (const standing of this.standings.values()) counts[standing] += 1
    setCredentialStandings(counts)
  }
}

export interface ConfirmSummary {
  confirmed: number
  expired: number
  unconfirmed: number
}

/**
 * Confirm every credential in the vault, at startup. Never throws: a gateway that is down at boot
 * leaves records `unconfirmed`, and the next sale tries again.
 */
export async function confirmAll(
  vault: CredentialVault,
  confirmer: CredentialConfirmer,
): Promise<ConfirmSummary> {
  const summary: ConfirmSummary = { confirmed: 0, expired: 0, unconfirmed: 0 }
  let credentials: StallCredential[]
  try {
    credentials = await vault.all()
  } catch {
    return summary
  }
  const standings = await Promise.all(credentials.map((c) => confirmer.confirm(c)))
  standings.forEach((standing, i) => {
    summary[standing] += 1
    if (standing === 'expired') {
      console.error(
        JSON.stringify({
          event: 'purchase_issuer_credential_expired',
          stall: credentials[i].stallPubkey.slice(0, 16),
          credential: credentials[i].credentialId.slice(0, 8),
          detail: 're-enrol the purchase issuer for this stall; its card sales cannot mint',
        }),
      )
    }
  })
  return summary
}
