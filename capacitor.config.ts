import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'xyz.tcheeric.imani.wallet',
  appName: 'Imani Wallet',
  webDir: 'dist',
  android: {
    // Paints behind the WebView while it boots. Without it the first frame is
    // white, which flashes on a dark device and looks like a reload.
    backgroundColor: '#fafafa',
  },
  server: {
    // Load staging rather than the bundle in `webDir`.
    //
    // Every API call in this app is a relative path — `/api/v1/auth`,
    // `/api/v1/resolve/…`, and nap's `baseUrl: '/api/v1'` — because in a browser
    // Vite proxies them to account-app and customer-wallet (see vite.config.ts).
    // Served from Capacitor's own local origin those paths resolve to the static
    // file server, which answers every one of them with index.html: the app
    // renders and then fails on `Unexpected token '<'`. Pointing the WebView at
    // the real origin makes the relative paths correct again, and the NAP
    // session cookie same-origin, with no CORS or SameSite plumbing.
    //
    // The cost is that `webDir` is then dead weight and the app needs a network
    // to start. It also means the running JS is whatever staging serves — so
    // `initNative()` and the onboarding back-button fix only exist on the device
    // once this branch is deployed there. Delete this block to go back to the
    // bundled build.
    url: 'https://wallet.staging.398ja.xyz',
  },
  plugins: {
    Keyboard: {
      // Resize the WebView rather than sliding it, so a focused input at the
      // bottom of a scrollable page stays visible instead of going under the
      // keyboard. `body` over `native` because the layout is a normal document
      // flow with a sticky header, which is exactly what `body` assumes.
      resize: KeyboardResize.Body,
    },
    SplashScreen: {
      // Android 12+ shows the system splash from the launch theme; this covers
      // everything older, where the plugin draws its own view. Both run the
      // same AnimatedVectorDrawable — the plugin calls start() on any Animatable
      // it finds, including inside the layer-list.
      androidSplashResourceName: 'imani_mark_animated',
      // CENTER, not the plugin's usual FIT_XY: that stretches the drawable to
      // the view, and a 1:1 mark pulled to a portrait screen is visibly wrong.
      // Unscaled and centred, the vector's own 144dp is the size.
      androidScaleType: 'CENTER',
      // No backgroundColor on purpose. The plugin only paints one if it is set,
      // and it takes a single hex string with no dark variant — it would show a
      // #fafafa mark on a #fafafa field at night. Left unset, the theme's
      // android:windowBackground shows through, and that one has values-night.
      showSpinner: false,
      // `server.url` is a remote origin, so the splash is covering a real
      // network fetch and not just a bundle parse. main.tsx hides it the frame
      // after React first paints; this is only the ceiling for the case where
      // that never happens, because a splash with no network behind it must
      // still let the user reach the WebView's own error page.
      launchAutoHide: true,
      launchShowDuration: 5000,
      launchFadeOutDuration: 200,
    },
  },
};

export default config;
