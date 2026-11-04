import { Capacitor } from '@capacitor/core'
import { DriveAuth } from './native/driveAuth'

/**
 * Where the Drive access token comes from, by platform.
 *
 * - Web: Google Identity Services' implicit token client (a consent popup).
 * - Android: the app's DriveAuth plugin, Play services AuthorizationClient.
 *   GIS cannot work in the Capacitor WebView: Google refuses OAuth in embedded
 *   WebViews (`disallowed_useragent`), and the popup goes to the system
 *   browser, which has no opener to postMessage the token back to.
 * - iOS: no app exists, so it fails fast rather than spinning.
 *
 * Either way the token stays on the device and is only ever sent to
 * googleapis.com. No Imani server sees it.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const GIS_SRC = 'https://accounts.google.com/gsi/client'

export class DriveError extends Error {
  constructor(
    message: string,
    /** HTTP status when Drive itself refused the request. */
    readonly status?: number,
  ) {
    super(message)
  }
}

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

/**
 * Ceiling on waiting for a token. Generous, because a real person may be
 * picking an account or typing a password, but finite: GIS has environments
 * (blocked popups) where neither callback ever fires, and an unsettled promise
 * is a button that spins forever. Applied to the native path too, as a backstop.
 */
export const TOKEN_TIMEOUT_MS = 3 * 60 * 1000

export const CANCELLED = 'Google sign-in was cancelled.'
export const SCOPE_NOT_GRANTED =
  'Google did not grant access to the app folder in your Drive. Try again and leave the Drive permission ticked.'
export const NATIVE_UNSUPPORTED =
  'Google Drive backup is not available in this app yet. Save the backup file instead, ' +
  'or back up to Drive from the web wallet in a browser.'

type Platform = 'web' | 'android' | 'other'

function platform(): Platform {
  const p = Capacitor.getPlatform()
  return p === 'web' ? 'web' : p === 'android' ? 'android' : 'other'
}

function clientId(): string {
  return ((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '').trim()
}

/**
 * Whether this build can reach Google at all. Android needs no client id in
 * code (Play services matches package name and signing certificate), so it is
 * always configured. The web needs VITE_GOOGLE_CLIENT_ID.
 */
export function driveConfigured(): boolean {
  return platform() === 'android' || clientId() !== ''
}

function withCeiling<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DriveError('Google sign-in did not finish. Allow pop-ups for this site and try again.')),
      TOKEN_TIMEOUT_MS,
    )
    work.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
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
 * Web: one access token, one user gesture. Not cached: both Drive actions are
 * single taps, and a stale token would fail inside the operation.
 *
 * ponytail: implicit token flow, so the token is not refreshable and each
 * backup or restore costs one account chooser.
 */
async function gisToken(): Promise<string> {
  const id = clientId()
  if (!id) {
    throw new DriveError(
      'This app is not set up for Google Drive yet, so it cannot open a Google sign-in. ' +
        'Save the backup file instead, or ask whoever runs this deployment to add a Google client id.',
    )
  }

  await loadGis()
  const oauth2 = window.google?.accounts.oauth2
  if (!oauth2) throw new DriveError('Could not reach Google. Check your connection and try again.')

  return withCeiling(
    new Promise<string>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: id,
        scope: DRIVE_SCOPE,
        callback: (response) => {
          if (response.access_token) return resolve(response.access_token)
          reject(new DriveError(response.error_description ?? 'Google did not grant access to Drive.'))
        },
        // Closing the chooser is a decision, not a fault.
        error_callback: () => reject(new DriveError(CANCELLED)),
      })
      client.requestAccessToken()
    }),
  )
}

/**
 * Android: Play services authorization. The first time shows Google's consent
 * screen; while the grant stands it returns a token with no UI at all.
 */
async function nativeToken(): Promise<string> {
  let result: { accessToken: string; grantedScopes: string[] }
  try {
    result = await withCeiling(DriveAuth.authorize({ scopes: [DRIVE_SCOPE] }))
  } catch (e) {
    if (e instanceof DriveError) throw e
    if ((e as { code?: string } | null)?.code === 'cancelled') throw new DriveError(CANCELLED)
    throw new DriveError('Google did not grant access to Drive. Try again in a moment.')
  }
  // The consent screen lets the person untick the scope and still "allow".
  if (!result.grantedScopes?.includes(DRIVE_SCOPE)) throw new DriveError(SCOPE_NOT_GRANTED)
  if (!result.accessToken) throw new DriveError('Google did not grant access to Drive.')
  return result.accessToken
}

/** A Drive access token for the `drive.appdata` scope on this platform. */
export function driveAccessToken(): Promise<string> {
  switch (platform()) {
    case 'web':
      return gisToken()
    case 'android':
      return nativeToken()
    default:
      return Promise.reject(new DriveError(NATIVE_UNSUPPORTED))
  }
}

/**
 * Run one Drive operation with a token.
 *
 * On Android a 401 means Play services handed back a cached token Google has
 * since refused (revoked grant, expiry). Clear it, authorize again, and retry
 * exactly once. On the web each token is fresh from GIS, so a 401 is final
 * there and a retry would only pop a second chooser.
 */
export async function withDriveToken<T>(operation: (token: string) => Promise<T>): Promise<T> {
  const token = await driveAccessToken()
  try {
    return await operation(token)
  } catch (e) {
    if (!(e instanceof DriveError) || e.status !== 401 || platform() !== 'android') throw e
    await DriveAuth.clearToken({ accessToken: token }).catch(() => undefined)
    return operation(await driveAccessToken())
  }
}
