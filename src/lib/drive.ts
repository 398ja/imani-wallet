import { Capacitor } from '@capacitor/core'
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
 *   held in this tab's memory for the minute it takes to do one call, the
 *   request goes browser → googleapis.com, and the encrypted file lands in
 *   storage the customer owns and can delete without asking anyone.
 *
 * Google Identity Services rather than the older gapi client: it is the only
 * flow Google still supports for this, it needs no API key alongside the client
 * id, and it hands back a bare token we can use with `fetch`.
 *
 * ponytail: implicit token flow, so the token is not refreshable and each
 * backup or restore costs one account chooser. Fine for an action taken twice
 * in an account's life; if Drive backup ever becomes automatic and periodic this
 * wants the auth-code flow and a refresh token instead.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const FILES = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

interface TokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string
            scope: string
            callback: (response: TokenResponse) => void
            error_callback?: (error: { type?: string }) => void
          }): TokenClient
        }
      }
    }
  }
}

export class DriveError extends Error {}

/**
 * Ceiling on waiting for Google's token callback. Generous, because a real
 * person may be picking an account or typing a password, but finite: GIS has
 * environments (blocked popups, embedded WebViews) where neither `callback` nor
 * `error_callback` ever fires, and an unsettled promise is a button that spins
 * forever.
 */
export const TOKEN_TIMEOUT_MS = 3 * 60 * 1000

export const NATIVE_UNSUPPORTED =
  'Google Drive backup is not available in the Android app yet: Google does not allow its sign-in ' +
  'inside an app WebView. Save the backup file instead, or back up to Drive from the web wallet in a browser.'

/**
 * Why the Android app cannot run this flow at all.
 *
 * The app is a Capacitor WebView. GIS's token client opens its consent page
 * with `window.open`; Capacitor's WebView has no multi-window support, so the
 * popup is either dropped or handed to the system browser via an ACTION_VIEW
 * intent (Bridge.launchIntent). In the browser it is a separate window with no
 * `opener`, so the postMessage back never arrives; and Google refuses OAuth in
 * embedded WebViews anyway (`disallowed_useragent`). Either way neither GIS
 * callback fires. Fixing this properly needs native Google sign-in with an
 * Android OAuth client, which is a Google Cloud console change.
 */
function nativeApp(): boolean {
  return Capacitor.isNativePlatform()
}

/**
 * Whether this build carries the OAuth client id Google needs.
 *
 * NOT a gate on showing the buttons — they are offered everywhere, so that
 * "back this up to Drive" is a thing the product visibly does rather than a
 * feature that appears only on correctly configured deployments. This exists so
 * the failure can name itself: an unconfigured build says so in one sentence
 * instead of handing over whatever Google returns for a client that does not
 * exist (`invalid_client`, in a popup, with no route back).
 *
 * The client id identifies the APP, not the customer. It is public — it ships
 * in this bundle and Google sees it on every sign-in — but it has to exist, and
 * it has to list this origin. There is no Google API reachable without one, so
 * a deployment without it cannot complete a backup however the button behaves.
 */
export function driveConfigured(): boolean {
  return clientId() !== ''
}

function clientId(): string {
  return ((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '').trim()
}

let scriptLoad: Promise<void> | undefined

/** Loaded on demand, not in index.html: most sessions never touch Drive. */
function loadGis(): Promise<void> {
  if (scriptLoad) return scriptLoad

  scriptLoad = new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve()

    const script = document.createElement('script')
    script.src = GIS_SRC
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      // Cleared so a customer who fixes their connection and taps again gets a
      // real second attempt rather than this same rejection forever.
      scriptLoad = undefined
      reject(new DriveError('Could not reach Google. Check your connection and try again.'))
    }
    document.head.appendChild(script)
  })

  return scriptLoad
}

/**
 * One access token, one user gesture.
 *
 * Not cached. A token lives an hour and caching it across a page that also
 * holds an unlocked key buys nothing — both Drive actions are single calls
 * initiated by a tap, and a stale token would fail inside the operation rather
 * than at the door.
 */
async function accessToken(): Promise<string> {
  const id = clientId()
  if (!id) {
    throw new DriveError(
      'This app is not set up for Google Drive yet, so it cannot open a Google sign-in. ' +
        'Save the backup file instead, or ask whoever runs this deployment to add a Google client id.',
    )
  }

  if (nativeApp()) throw new DriveError(NATIVE_UNSUPPORTED)

  await loadGis()
  const oauth2 = window.google?.accounts.oauth2
  if (!oauth2) throw new DriveError('Could not reach Google. Check your connection and try again.')

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DriveError('Google sign-in did not finish. Allow pop-ups for this site and try again.')),
      TOKEN_TIMEOUT_MS,
    )
    const settle = <T>(fn: (v: T) => void) => (v: T) => {
      clearTimeout(timer)
      fn(v)
    }
    const ok = settle(resolve)
    const fail = settle(reject)
    const client = oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: (response) => {
        if (response.access_token) return ok(response.access_token)
        fail(new DriveError(response.error_description ?? 'Google did not grant access to Drive.'))
      },
      // Closing the chooser is a decision, not a fault. Without this the
      // promise never settles and the button spins for the rest of the session.
      error_callback: () => fail(new DriveError('Google sign-in was cancelled.')),
    })
    client.requestAccessToken()
  })
}

async function call(token: string, url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    throw new DriveError(`Google Drive refused the request (${response.status}).`)
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
export async function putBackup(json: string): Promise<void> {
  const token = await accessToken()
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
export async function getBackup(): Promise<string | null> {
  const token = await accessToken()
  const id = await findBackup(token)
  if (!id) return null

  return (await call(token, `${FILES}/${id}?alt=media`)).text()
}
