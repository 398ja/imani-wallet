import { ESCROW_FILENAME } from './escrow'

/**
 * The customer's own Google Drive, as an escrow target.
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
 * in an account's life; if escrow ever becomes automatic and periodic this
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
 * Whether Drive escrow is offered at all.
 *
 * The client id is per-deployment and there is no sane default, so an
 * unconfigured build hides the buttons rather than showing one that fails at
 * the moment the customer is most anxious. Same fail-closed shape as
 * `cashbackOrigins` in lib/config.ts.
 */
export function driveConfigured(): boolean {
  return clientId() !== ''
}

function clientId(): string {
  return ((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '').trim()
}

let scriptLoad: Promise<void> | undefined

/** Loaded on demand, not in index.html: most sessions never touch escrow. */
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
 * holds an unlocked key buys nothing — both escrow actions are single calls
 * initiated by a tap, and a stale token would fail inside the operation rather
 * than at the door.
 */
async function accessToken(): Promise<string> {
  const id = clientId()
  if (!id) throw new DriveError('Google Drive backup is not configured for this deployment.')

  await loadGis()
  const oauth2 = window.google?.accounts.oauth2
  if (!oauth2) throw new DriveError('Could not reach Google. Check your connection and try again.')

  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: (response) => {
        if (response.access_token) return resolve(response.access_token)
        reject(new DriveError(response.error_description ?? 'Google did not grant access to Drive.'))
      },
      // Closing the chooser is a decision, not a fault. Without this the
      // promise never settles and the button spins for the rest of the session.
      error_callback: () => reject(new DriveError('Google sign-in was cancelled.')),
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

/** The escrow file's Drive id, or null when this account has never escrowed. */
async function findEscrow(token: string): Promise<string | null> {
  const query = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${ESCROW_FILENAME}' and trashed = false`,
    fields: 'files(id)',
    pageSize: '1',
  })

  const body = (await (await call(token, `${FILES}?${query}`)).json()) as { files?: { id: string }[] }
  return body.files?.[0]?.id ?? null
}

/**
 * Write the escrow, replacing any earlier one.
 *
 * Update-in-place rather than a second file, so a customer who backs up twice
 * cannot end up restoring the older of two indistinguishable copies. Drive
 * keeps its own revision history of the file, which is the right place for the
 * old one to live.
 */
export async function putEscrow(json: string): Promise<void> {
  const token = await accessToken()
  const existing = await findEscrow(token)

  const metadata = existing
    ? { name: ESCROW_FILENAME }
    : { name: ESCROW_FILENAME, parents: ['appDataFolder'] }

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

/** The escrow file's text, or null when this Google account holds none. */
export async function getEscrow(): Promise<string | null> {
  const token = await accessToken()
  const id = await findEscrow(token)
  if (!id) return null

  return (await call(token, `${FILES}/${id}?alt=media`)).text()
}
