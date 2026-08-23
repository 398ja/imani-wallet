import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { StatusBar, Style } from '@capacitor/status-bar'

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

  // Ask for the status bar area to be reserved rather than drawn under.
  //
  // Android 15 ignores this: targetSdk 35 enforces edge-to-edge, and a Pixel
  // duly rendered the header behind the clock where it could not be tapped. So
  // Header pads itself with `env(safe-area-inset-top)`, which is the case this
  // call was meant to avoid. It stays for everything older, where it IS
  // honoured and the inset is then 0 — the two do not double up.
  StatusBar.setOverlaysWebView({ overlay: false })
  // --background, light theme. Matched by hand: Tailwind's tokens are CSS
  // variables the native layer cannot read.
  StatusBar.setBackgroundColor({ color: '#fafafa' })
  // Dark icons, because that background is light. Style.Light means "for a
  // light background", which reads backwards.
  StatusBar.setStyle({ style: Style.Light })
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
