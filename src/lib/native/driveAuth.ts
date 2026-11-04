import { registerPlugin } from '@capacitor/core'

/**
 * The app's local Android plugin (android/app/src/main/java/.../DriveAuthPlugin.java):
 * Play services AuthorizationClient for one OAuth scope. Authorization only, no sign-in.
 *
 * Rejections carry `code`: `cancelled` when the person closed the consent screen,
 * `failed` otherwise (including DEVELOPER_ERROR for a package/SHA-1 mismatch).
 */
export interface DriveAuthPlugin {
  authorize(options: { scopes: string[] }): Promise<{ accessToken: string; grantedScopes: string[] }>
  /** Drop a token Play services cached but Google has since refused (a Drive 401). */
  clearToken(options: { accessToken: string }): Promise<void>
}

export const DriveAuth = registerPlugin<DriveAuthPlugin>('DriveAuth')
