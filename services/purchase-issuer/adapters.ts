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
