/**
 * The parts of the worker that touch the world.
 *
 * `discharge.ts` declares `Ports` and takes them as an argument precisely so
 * its logic can be tested without a disk, a clock or a gateway. This is the
 * other half: the real implementations, kept together and kept thin, so the
 * interesting decisions stay in the module that has tests for them.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

import { authorization, IssuanceFailed, ISSUE_PATH, type StallCredential } from './issuer'
import type { CredentialStore } from './vault'

/**
 * Sealed credentials in a file.
 *
 * A file rather than a database because the vault's own comment already says
 * what this is: a small store of sealed blobs, replaceable by a secrets
 * manager later without changing what is sealed or when. Adding a database for
 * a handful of rows would be the larger commitment.
 *
 * ## Written through a temporary file
 *
 * `writeFile` truncates and then writes, so a crash between those two leaves a
 * ZERO-BYTE file where the credentials were. Every stall would silently fall
 * back to issuing by hand, and the vault's own error handling would help hide
 * it: an unreadable record is skipped rather than thrown, exactly as designed,
 * so the logs would show nothing at all.
 *
 * Writing to a sibling and renaming makes the swap atomic on POSIX. A crash
 * leaves either the old file or the new one, never a truncated one. The
 * temporary file is a SIBLING, not in /tmp, because rename across filesystems
 * fails with EXDEV and containers routinely mount /tmp separately.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  async read(): Promise<never[]> {
    try {
      const raw = await readFile(this.path, 'utf8')
      const decoded: unknown = JSON.parse(raw)
      return (Array.isArray(decoded) ? decoded : []) as never[]
    } catch {
      // A missing file is the ORDINARY state of a fresh deployment: no stall
      // has enrolled yet. Indistinguishable here from a corrupt one, and both
      // land where the design already sends a stall with no credential, which
      // is issuing by hand.
      return [] as never[]
    }
  }

  async write(records: readonly unknown[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(records, null, 2), {
      // 0600. These are sealed, but the sealing key sits in the environment of
      // this same process, so a world-readable file plus a leaked environment
      // is one mistake rather than two.
      mode: 0o600,
    })
    await rename(temporary, this.path)
  }
}

/**
 * Fetch the token for a coupon whose mint had not finished.
 *
 * Minting is asynchronous: the gateway returns a voucher id immediately and
 * the token appears seconds later. `imani-woo` shipped delivery on the
 * issuance response alone and DM'd customers a coupon worth nothing, which is
 * why `discharge.ts` polls for this rather than assuming.
 *
 * The path is the issuance path plus the voucher id — the same endpoint
 * `scripts/mint-terminal-credential.mjs` polls, deliberately not a second
 * opinion about where a coupon lives.
 */
export async function tokenFor(
  gatewayUrl: string,
  credential: StallCredential,
  voucherId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `${gatewayUrl.replace(/\/$/, '')}${ISSUE_PATH}/${encodeURIComponent(voucherId)}`

  let response: Response
  try {
    // Signed with the credential's lock key, exactly as issuance is. The
    // coupon belongs to the stall, and this asks for a bearer token to it.
    //
    // The body is the EMPTY STRING, not '{}'. A NIP-98 payload tag is the hash
    // of the body actually sent, and a GET sends nothing; hashing '{}' would
    // produce a signature over a body that never existed.
    response = await fetchImpl(url, {
      headers: { Authorization: authorization('GET', url, '', credential.lockKeyHex) },
    })
  } catch (error) {
    throw new IssuanceFailed(
      error instanceof Error ? error.message : 'could not reach the gateway',
      true,
    )
  }

  if (response.status !== 200) {
    throw new IssuanceFailed(`the gateway answered ${response.status}`, true)
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(await response.text())
  } catch {
    throw new IssuanceFailed('the gateway returned something that was not JSON', true)
  }

  const record = (decoded ?? {}) as Record<string, unknown>
  // '' means "still minting", which the caller polls through. It is NOT an
  // error: a coupon mid-mint is the expected state for the first second or so.
  return typeof record.token === 'string' ? record.token : ''
}

/** Where a terminal credential is put in service (gateway-customer#187, V27). */
export const CONFIRM_PATH = (voucherId: string) =>
  `/api/v1/wallet/terminal-credentials/${encodeURIComponent(voucherId)}/confirm`

/**
 * Put a stall credential in service at the gateway (imani-wallet#160 round 2).
 *
 * Since gateway-customer V27, every terminal credential minted after the migration must be
 * confirmed by its device or its stall before it may issue. The credentials this service
 * holds are terminal credentials it presents in `X-Imani-Terminal-Credential`, so an
 * unconfirmed one is refused on every sale. This confirms as the device (the lock key).
 *
 * 204 means in service; it is idempotent, so a credential already confirmed (or minted before
 * V27) is fine to confirm again. Returns false on any other answer, and never throws: issuance
 * itself then fails loudly and the debt stays owed.
 */
export async function confirmCredential(
  gatewayUrl: string,
  credential: StallCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  return (await confirmStanding(gatewayUrl, credential, fetchImpl)) === 'confirmed'
}

/**
 * What the gateway said to a confirm (imani-wallet#296).
 *
 *  - `confirmed`: 200/204, in service.
 *  - `expired`: 410. The credential sat unconfirmed past the gateway's 24 h window and can never be
 *    confirmed now. The stall must re-enrol this issuer; nothing retried here can fix it.
 *  - `unconfirmed`: anything else (network, 5xx, 401). Worth trying again later.
 */
export type ConfirmStanding = 'confirmed' | 'expired' | 'unconfirmed'

/**
 * How long one confirm may take (review of #299). Without a bound, a gateway that accepts the
 * connection and never answers held the startup confirm, and so the first pass, forever.
 */
export const CONFIRM_TIMEOUT_MS = 10_000

export async function confirmStanding(
  gatewayUrl: string,
  credential: StallCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ConfirmStanding> {
  const url = `${gatewayUrl.replace(/\/$/, '')}${CONFIRM_PATH(credential.credentialId)}`
  // The same request the wallet sends: an empty JSON object, signed in the `payload` tag. The
  // gateway reads nothing from it. An empty body signed as sha256('') passes the filter too, but
  // one shape for every caller of this endpoint is one shape to test (imani-wallet 0.14.2).
  const body = '{}'
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        // Signed afresh on every call: `authorization` adds a random nonce, so a retry is never a
        // replay of an earlier event (#296).
        Authorization: authorization('POST', url, body, credential.lockKeyHex),
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS),
    })
    if (response.status === 204 || response.status === 200) return 'confirmed'
    console.warn(
      JSON.stringify({
        event: 'credential_confirm_refused',
        stall: credential.stallPubkey.slice(0, 16),
        status: response.status,
      }),
    )
    return response.status === 410 ? 'expired' : 'unconfirmed'
  } catch {
    return 'unconfirmed'
  }
}
