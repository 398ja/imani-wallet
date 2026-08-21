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
