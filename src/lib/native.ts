import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core'
import { App } from '@capacitor/app'

/**
 * The handful of things a web build cannot know about Android.
 *
 * Everything here is a no-op in a browser — `isNativePlatform()` is false, so
 * `npm run dev` and the deployed web wallet are untouched by this file.
 */
export function initNative(): void {
  if (!Capacitor.isNativePlatform()) return

  // Android's back gesture is the primary navigation on the platform, and
  // react-router knows nothing about it. Without this the swipe kills the app
  // from any screen, which reads as a crash rather than as navigation.
  //
  // `canGoBack` is the WebView's own history depth, which BrowserRouter drives,
  // so this needs no router context and cannot desync from it.
  App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) window.history.back()
    else App.exitApp()
  })

  // targetSdk 36 (Android 16) enforces edge-to-edge with no opt-out: the
  // WebView always draws under the status and navigation bars, and a status
  // bar background colour can no longer be set. So there is nothing to reserve
  // natively. Header pads itself with `env(safe-area-inset-top)` and #root and
  // the Toaster with `env(safe-area-inset-bottom)`; Capacitor 8's SystemBars
  // (insetsHandling in capacitor.config.ts) makes those values correct even on
  // WebViews older than Chromium 140. All that is left is the icon colour:
  // dark icons, because the header material is light. SystemBarsStyle.Light
  // means "for a light background", which reads backwards.
  void SystemBars.setStyle({ style: SystemBarsStyle.Light }).catch(() => {})
}

/**
 * Dismiss the launch splash once the app is actually on screen.
 *
 * The splash is not decoration here: `server.url` in capacitor.config.ts points
 * at a remote origin, so a cold start waits on a network fetch before any React
 * code runs at all. Without this the user watches a flat colour for that whole
 * time and cannot tell a slow connection from a dead app.
 *
 * Called after the first paint rather than from initNative(), which runs before
 * render — hiding there would uncover an empty document. `launchAutoHide` still
 * backstops it, so a boot that never paints is not stranded on the splash.
 */
export async function hideSplash(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen')
    await SplashScreen.hide()
  } catch {
    // Already hidden by launchAutoHide, or the plugin is not installed.
  }
}

/**
 * Read the clipboard, on a platform where the web API is not enough.
 *
 * `navigator.clipboard.readText()` is not implemented in Android's WebView, so
 * on device every Paste button in this app threw and reported "Could not read
 * the clipboard" — the camera being unavailable is exactly when paste matters,
 * so the fallback was broken in the one case it existed for.
 *
 * Capacitor's plugin is the native path; the web API stays for `npm run dev`
 * and the deployed web wallet, where it works and the plugin is a no-op shim.
 * Returns null rather than throwing: every caller shows the same message, and
 * there is nothing a caller could do differently with the reason.
 */
export async function readClipboard(): Promise<string | null> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { Clipboard } = await import('@capacitor/clipboard')
      const { value } = await Clipboard.read()
      return value || null
    }
    return (await navigator.clipboard.readText()) || null
  } catch {
    return null
  }
}

/**
 * Whether a share sheet can be opened at all.
 *
 * Android's WebView does not implement the Web Share API, so `navigator.share`
 * is undefined inside the app — which is why the Share button was missing on
 * the merchant's own profile while the customer's view of a stall still showed
 * one (that button silently falls back to Copy). On native the plugin is the
 * share sheet; on the web build the browser API is, and where neither exists
 * there is genuinely nothing to share to and the caller should say Copy.
 */
export function canShare(): boolean {
  return Capacitor.isNativePlatform() || typeof navigator.share === 'function'
}

/**
 * Opens the share sheet with a bare string.
 *
 * `text`, never `url`: what goes out is a handle like `song@domain`, and Android
 * drops a `url` that is not one. Returns false when the sheet could not open so
 * the caller can fall back to the clipboard; a *dismissed* sheet also lands
 * here, which is harmless — copying what someone declined to share costs them
 * nothing.
 */
export async function shareText(text: string): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { Share } = await import('@capacitor/share')
      await Share.share({ text })
      return true
    }
    if (typeof navigator.share === 'function') {
      await navigator.share({ text })
      return true
    }
  } catch {
    // Cancelled, or no target installed.
  }
  return false
}
