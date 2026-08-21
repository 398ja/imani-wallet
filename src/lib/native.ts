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

  // Reserve the status bar area rather than drawing under it. The alternative
  // — overlay plus `env(safe-area-inset-top)` padding — puts the page
  // background behind the clock instead of the sticky Header's own surface,
  // which looks like a rendering bug on every scrolled screen.
  StatusBar.setOverlaysWebView({ overlay: false })
  // --background, light theme. Matched by hand: Tailwind's tokens are CSS
  // variables the native layer cannot read.
  StatusBar.setBackgroundColor({ color: '#fafafa' })
  // Dark icons, because that background is light. Style.Light means "for a
  // light background", which reads backwards.
  StatusBar.setStyle({ style: Style.Light })
}
