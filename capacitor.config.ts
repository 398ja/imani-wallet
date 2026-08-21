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
  },
};

export default config;
