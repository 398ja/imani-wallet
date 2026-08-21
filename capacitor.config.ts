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
