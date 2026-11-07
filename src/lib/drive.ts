import { DriveError, withDriveToken } from './googleToken'
import { DRIVE_FILENAME } from './backup'

/**
 * The customer's own Google Drive, as a backup target.
 *
 * Two things make this defensible against the promise the wallet makes
 * elsewhere ("there is no honeypot"):
 *
 * - The scope is `drive.appdata`, not `drive.file` and certainly not `drive`.
 *   It reaches ONE hidden per-app folder in the customer's Drive and nothing
 *   else — this code cannot read their documents, and could not be made to.
 * - No token, file or key ever reaches an Imani server. The access token is
 *   held in memory for the minute it takes to do one call, the request goes
 *   device → googleapis.com, and the encrypted file lands in storage the
 *   customer owns and can delete without asking anyone.
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

/**
 * The account file's Drive id, or null when this account has never backed up.
 *
 * One fixed address, resolved rather than chosen: the `drive.appdata` scope
 * addresses a single hidden per-app folder, and the name is a constant. Nobody
 * picks a location on either side — there is no location to pick, and a
 * customer restoring on a borrowed phone must not have to remember one.
 *
 * `modifiedTime desc` rather than whatever comes first. Two devices backing up
 * before either has written the file both see nothing and both POST, and Drive
 * is content to hold two files of the same name in the same folder. After that
 * "the fixed location" holds two answers, and an unordered query would hand
 * restore an arbitrary one — in practice the older, since it was created first.
 * Newest-wins makes the duplicate harmless: reads take it, and the write below
 * updates that same one, so the pair converges instead of alternating.
 */
async function findBackup(token: string): Promise<string | null> {
  const query = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${DRIVE_FILENAME}' and trashed = false`,
    fields: 'files(id)',
    orderBy: 'modifiedTime desc',
    pageSize: '1',
  })

  const body = (await (await call(token, `${FILES}?${query}`)).json()) as { files?: { id: string }[] }
  return body.files?.[0]?.id ?? null
}

/**
 * Write the account file, replacing any earlier one.
 *
 * Update-in-place rather than a second file, so a customer who backs up twice
 * cannot end up restoring the older of two indistinguishable copies. Drive
 * keeps its own revision history of the file, which is the right place for the
 * old one to live.
 */
export function putBackup(json: string): Promise<void> {
  return withDriveToken((token) => upload(token, json))
}

async function upload(token: string, json: string): Promise<void> {
  const existing = await findBackup(token)

  const metadata = existing
    ? { name: DRIVE_FILENAME }
    : { name: DRIVE_FILENAME, parents: ['appDataFolder'] }

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

/** The account file's text, or null when this Google account holds none. */
export function getBackup(): Promise<string | null> {
  return withDriveToken(download)
}

async function download(token: string): Promise<string | null> {
  const id = await findBackup(token)
  if (!id) return null

  return (await call(token, `${FILES}/${id}?alt=media`)).text()
}
