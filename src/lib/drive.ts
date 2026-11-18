import { nip19 } from 'nostr-tools'

import { DriveError, withDriveToken } from './googleToken'
import { DRIVE_FILENAME, driveFilename } from './backup'

/**
 * The customer's own Google Drive, as a backup target.
 *
 * Two things make this defensible against the promise the wallet makes
 * elsewhere ("there is no honeypot"):
 *
 * - The scope is `drive.appdata`, not `drive.file` and certainly not `drive`.
 *   It reaches ONE hidden per-app folder in the customer's Drive and nothing
 *   else. This code cannot read their documents, and could not be made to.
 * - No token, file or key ever reaches an Imani server. The access token is
 *   held in memory for the minute it takes to do one call, the request goes
 *   device to googleapis.com, and the encrypted file lands in storage the
 *   customer owns and can delete without asking anyone.
 *
 * One file per account (#559): `imani-wallet-account-<pubkey>.json`, tagged
 * with `appProperties { pubkey, npub, nip05 }`. The web wallet and the Android
 * app share one appDataFolder, and so does every Imani account a person backs
 * up to the same Google account. A single fixed file let the second backup
 * overwrite the first account's key. The old fixed file
 * (`imani-wallet-account.json`) is never written again and stays readable,
 * together with its Drive revisions, so a key it once held can still come back.
 *
 * The token itself comes from `googleToken.ts`: Google Identity Services in a
 * browser, Play services authorization in the Android app.
 */

const FILES = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

export { DriveError, TOKEN_TIMEOUT_MS, NATIVE_UNSUPPORTED, driveConfigured } from './googleToken'

async function call(token: string, url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    throw new DriveError(`Google Drive refused the request (${response.status}).`, response.status)
  }
  return response
}

interface DriveFile {
  id: string
  name: string
  modifiedTime?: string
  appProperties?: Record<string, string>
}

/** One account backup found in Drive, with its text already downloaded. */
export interface DriveBackup {
  /** Unique per choice: the file id, or `fileId@revisionId` for an older revision. */
  id: string
  fileId: string
  revisionId?: string
  /** The old fixed-name file, or one of its revisions. */
  legacy: boolean
  pubkey: string | null
  npub: string | null
  nip05: string | null
  modifiedTime: string
  text: string
}

/** Pubkeys are hex, so this only guards the query against anything else. */
function hex(pubkey: string): string {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new DriveError('That backup does not name a valid account.')
  return pubkey
}

/**
 * The Drive id of THIS account's file, or null when it has never backed up.
 *
 * Matched by `appProperties.pubkey` or by the per-pubkey name, never by the
 * legacy name: another account's file is not this account's to overwrite.
 *
 * `modifiedTime desc` rather than whatever comes first. Two devices backing up
 * before either has written the file both see nothing and both POST, and Drive
 * is content to hold two files of the same name. Newest-wins makes the
 * duplicate harmless: reads take it, and the write updates that same one.
 */
async function findAccountFile(token: string, pubkey: string): Promise<string | null> {
  const query = new URLSearchParams({
    spaces: 'appDataFolder',
    q:
      `(name = '${driveFilename(hex(pubkey))}' or appProperties has { key='pubkey' and value='${pubkey}' })` +
      ' and trashed = false',
    fields: 'files(id)',
    orderBy: 'modifiedTime desc',
    pageSize: '1',
  })

  const body = (await (await call(token, `${FILES}?${query}`)).json()) as { files?: { id: string }[] }
  return body.files?.[0]?.id ?? null
}

/**
 * Write this account's file, replacing its own earlier copy only.
 *
 * The account is read from the backup itself, so a caller cannot aim one
 * account's key at another account's file.
 */
export function putBackup(json: string): Promise<void> {
  return withDriveToken((token) => {
    const { pubkey, appProperties } = accountOf(json)
    return upload(token, pubkey, appProperties, json)
  })
}

/**
 * #348: write this account's file, then read it BACK in the same token and check it holds this
 * key's envelope and pubkey. Resolves only when the read-back matches, so a Drive backup recorded
 * as verified is one Drive really holds. Logout then trusts the record and needs no network.
 */
export function putAndVerifyBackup(json: string): Promise<void> {
  return withDriveToken(async (token) => {
    const { pubkey, appProperties } = accountOf(json)
    await upload(token, pubkey, appProperties, json)
    const id = await findAccountFile(token, pubkey)
    if (!id) throw new DriveError('Google Drive did not keep the backup. Try again.')
    const text = await (await call(token, `${FILES}/${id}?alt=media`)).text()
    if (!sameKey(json, text)) throw new DriveError('The backup in Google Drive does not match this key. Try again.')
  })
}

function sameKey(written: string, readBack: string): boolean {
  try {
    const a = JSON.parse(written) as { pubkey?: unknown; key?: unknown }
    const b = JSON.parse(readBack) as { pubkey?: unknown; key?: unknown }
    return a.pubkey === b.pubkey && b.key !== undefined && JSON.stringify(a.key) === JSON.stringify(b.key)
  } catch {
    return false
  }
}

function accountOf(json: string): { pubkey: string; appProperties: Record<string, string> } {
  const parsed = JSON.parse(json) as { pubkey?: unknown; npub?: unknown; profile?: { nip05?: unknown } | null }
  if (typeof parsed.pubkey !== 'string') {
    throw new DriveError('That backup does not name its account.')
  }
  const pubkey = hex(parsed.pubkey)
  const appProperties: Record<string, string> = {
    pubkey,
    npub: typeof parsed.npub === 'string' ? parsed.npub : nip19.npubEncode(pubkey),
  }
  if (typeof parsed.profile?.nip05 === 'string') appProperties.nip05 = parsed.profile.nip05
  return { pubkey, appProperties }
}

async function upload(
  token: string,
  pubkey: string,
  appProperties: Record<string, string>,
  json: string,
): Promise<void> {
  const existing = await findAccountFile(token, pubkey)
  const name = driveFilename(pubkey)

  const metadata = existing ? { name, appProperties } : { name, appProperties, parents: ['appDataFolder'] }

  // Multipart rather than two calls: metadata and content have to land together
  // or a crash between them leaves a named, empty file that restore would find.
  const boundary = `imani-${crypto.randomUUID()}`
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n` +
    `--${boundary}--`

  await call(token, `${UPLOAD}/${existing ?? ''}?uploadType=multipart`, {
    method: existing ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
}

/** Who a downloaded backup belongs to, from its own clear-text npub. */
function identityOf(text: string): { pubkey: string | null; npub: string | null; nip05: string | null } {
  try {
    const parsed = JSON.parse(text) as { npub?: unknown; profile?: { nip05?: unknown } | null }
    const nip05 = typeof parsed.profile?.nip05 === 'string' ? parsed.profile.nip05 : null
    if (typeof parsed.npub !== 'string') return { pubkey: null, npub: null, nip05 }
    const decoded = nip19.decode(parsed.npub)
    if (decoded.type !== 'npub') return { pubkey: null, npub: null, nip05 }
    return { pubkey: decoded.data, npub: parsed.npub, nip05 }
  } catch {
    return { pubkey: null, npub: null, nip05: null }
  }
}

/**
 * Every account backup in this Google account, newest first.
 *
 * Downloaded in the same token as the listing: on the web each token costs a
 * Google account chooser, and the files are a few kilobytes each. Per account
 * the newest file wins, as for writes. The legacy file comes with its older
 * Drive revisions (`revisions.list`, then `revisions/{id}?alt=media`, both
 * covered by `drive.appdata`), since a key it held before being overwritten
 * may only survive there.
 */
export function listBackups(): Promise<DriveBackup[]> {
  return withDriveToken(listAll)
}

async function listAll(token: string): Promise<DriveBackup[]> {
  const query = new URLSearchParams({
    spaces: 'appDataFolder',
    q: "name contains 'imani-wallet-account' and trashed = false",
    fields: 'files(id,name,modifiedTime,appProperties)',
    orderBy: 'modifiedTime desc',
    pageSize: '100',
  })
  const { files = [] } = (await (await call(token, `${FILES}?${query}`)).json()) as { files?: DriveFile[] }

  const found: DriveBackup[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const legacy = file.name === DRIVE_FILENAME
    const text = await (await call(token, `${FILES}/${file.id}?alt=media`)).text()
    const fromText = identityOf(text)
    const pubkey = legacy ? fromText.pubkey : (file.appProperties?.pubkey ?? fromText.pubkey)
    if (!legacy && pubkey) {
      if (seen.has(pubkey)) continue
      seen.add(pubkey)
    }
    found.push({
      id: file.id,
      fileId: file.id,
      legacy,
      pubkey,
      npub: legacy ? fromText.npub : (file.appProperties?.npub ?? fromText.npub),
      nip05: legacy ? fromText.nip05 : (file.appProperties?.nip05 ?? fromText.nip05),
      modifiedTime: file.modifiedTime ?? '',
      text,
    })
    if (legacy) found.push(...(await olderRevisions(token, file.id).catch(keepAuthErrors)))
  }

  return found.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))
}

/**
 * Older revisions are a bonus. A refusal there (other than a stale token, which
 * the caller retries) must not hide the backups already found.
 */
function keepAuthErrors(e: unknown): DriveBackup[] {
  if (e instanceof DriveError && e.status === 401) throw e
  return []
}

/** The legacy file's revisions other than its current one, each downloaded. */
async function olderRevisions(token: string, fileId: string): Promise<DriveBackup[]> {
  const query = new URLSearchParams({ fields: 'revisions(id,modifiedTime)', pageSize: '200' })
  const { revisions = [] } = (await (
    await call(token, `${FILES}/${fileId}/revisions?${query}`)
  ).json()) as { revisions?: { id: string; modifiedTime?: string }[] }

  // Listed oldest first; the last one is the file as it is now, already shown.
  const older = revisions.slice(0, -1)
  const out: DriveBackup[] = []
  for (const revision of older) {
    const text = await (await call(token, `${FILES}/${fileId}/revisions/${revision.id}?alt=media`)).text()
    out.push({
      id: `${fileId}@${revision.id}`,
      fileId,
      revisionId: revision.id,
      legacy: true,
      ...identityOf(text),
      modifiedTime: revision.modifiedTime ?? '',
      text,
    })
  }
  return out
}
