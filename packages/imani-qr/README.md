# imani-qr

QR scanning, detection, and routing utilities for the Imani wallet. Built on [nimiq/qr-scanner](https://github.com/nimiq/qr-scanner) for reliable QR code detection with native BarcodeDetector support.

## Features

- **High-performance scanning** using qr-scanner (2-3x better detection than alternatives)
- **Native BarcodeDetector** support when available (Chrome, Edge, Android)
- **WebWorker processing** keeps UI responsive during scanning
- **QR type detection** with prefix stripping (`cashu:`, `nostr:`) and custom patterns
- **Camera management** with preferred camera selection and switching
- **Feedback options** including vibration and beep on successful scan
- **Handlers** for payment requests (NUT-18V), Cashu tokens, and Nostr identities
- **Router** with default routes (send/receive/profile) and customizable configs
- **Factory helper** `createQrScanner` to wire scanner → detector → router

## Install

```bash
cd packages/imani-qr
npm install
```

Build (ESM + CJS + browser bundle + types via tsup):
```bash
npm run build
# outputs:
#   dist/index.js (ESM)
#   dist/index.cjs (CJS)
#   dist/index.browser.js (browser bundle)
#   dist/index.d.ts (types)
```

Run tests (Vitest):
```bash
npm test -- --watch=false
```

## Usage

### Browser (ES Module)

After building, copy the browser bundle to your lib directory:
```bash
cp dist/index.browser.js /path/to/lib/imani-qr.js
cp node_modules/qr-scanner/qr-scanner-worker.min.js /path/to/lib/
```

```html
<script type="module">
  import { createQrScanner, QrType } from '../lib/imani-qr.js';

  const { scanner, detector, router } = createQrScanner({
    scanner: {
      fps: 10,
      qrbox: { width: 250, height: 250 },
      preferredCamera: 'environment',
      cooldownMs: 2000,
      vibrate: true
    },
    onRoute: action => console.log(action),
    autoExecute: true
  });

  await scanner.start('scanner-container');
</script>
```

### NPM / Module

```ts
import {
  createQrScanner,
  QrTypeDetector,
  QrScanner,
  QrRouter,
  QrType
} from 'imani-qr';

// Quick setup with factory
const { scanner, detector, router } = createQrScanner({
  onRoute: action => console.log('Scanned:', action)
});

await scanner.start('my-container');

// Or use components individually
const detector = new QrTypeDetector();
const result = detector.detect('cashu:cashuA123...');
console.log(result.type); // QrType.CASHU_TOKEN
```

### Scanner Configuration

```ts
const scanner = new QrScanner({
  fps: 10,                        // Scans per second (default: 10)
  qrbox: { width: 250, height: 250 }, // Scan region size
  preferredCamera: 'environment', // 'environment' (back) or 'user' (front)
  cooldownMs: 2000,               // Debounce between scans (default: 2000)
  vibrate: true,                  // Haptic feedback on scan
  beep: false                     // Audio feedback on scan
});

// Event listeners
scanner.onScan(result => console.log('Scanned:', result.raw));
scanner.onStart(() => console.log('Scanner started'));
scanner.onStop(() => console.log('Scanner stopped'));
scanner.onError(err => console.error('Error:', err));

// Control methods
await scanner.start('container-id');
await scanner.stop();
scanner.pause();
scanner.resume();
await scanner.switchCamera();

// Static methods
const hasCamera = await QrScanner.hasCamera();
const cameras = await QrScanner.listCameras();
```

### Detector

```ts
const detector = new QrTypeDetector();

// Built-in types: PAYMENT_REQUEST, CASHU_TOKEN, NPUB, NIP05, UNKNOWN
const detection = detector.detect('vreqA123...');
console.log(detection.type);       // QrType.PAYMENT_REQUEST
console.log(detection.normalized); // 'vreqA123...' (prefix stripped)

// Register custom patterns
detector.registerPattern('lnurl', /^lnurl[a-z0-9]+$/i);
```

### Router

```ts
const router = new QrRouter({
  [QrType.PAYMENT_REQUEST]: {
    type: 'navigate',
    target: '/customer/send.html',
    paramKey: 'paymentRequest'
  },
  [QrType.CASHU_TOKEN]: {
    type: 'navigate',
    target: '/customer/receive.html',
    paramKey: 'token'
  },
  [QrType.NPUB]: {
    type: 'modal',
    target: 'ProfileModal',
    paramKey: 'identifier'
  }
});

const action = router.route(detection);
router.execute(action); // Performs navigation/modal/callback
```

### Handlers

Built-in handlers for parsing specific QR types:

- `PaymentRequestHandler` - Parses NUT-18V payment requests (uses global `NUT18V.parse` if available)
- `TokenHandler` - Parses Cashu tokens (cashuA/cashuB format)
- `IdentityHandler` - Handles npub and NIP-05 identifiers

```ts
import { HandlerRegistry, PaymentRequestHandler } from 'imani-qr';

const registry = new HandlerRegistry({
  [QrType.PAYMENT_REQUEST]: new PaymentRequestHandler()
});

const result = await registry.parse(detection);
```

## QR Types Supported

| Type | Prefix/Pattern | Example |
|------|---------------|---------|
| `PAYMENT_REQUEST` | `vreqA` | `vreqA1qqszqgpq...` |
| `CASHU_TOKEN` | `cashuA`, `cashuB` | `cashuAeyJ...` |
| `NPUB` | `npub1` (63 chars) | `npub1abc123...` |
| `NIP05` | `user@domain` | `alice@imani.casa` |
| `UR_FRAGMENT` | `ur:bytes/...` | `ur:bytes/1-5/abc...` |

Prefixes `cashu:` and `nostr:` are automatically stripped during detection.

## NUT-16 — Animated QR token transport (v0.4.0+)

Cashu V4 tokens with many proofs can exceed a single QR code's capacity. [NUT-16](https://github.com/cashubtc/nuts/blob/main/16.md) defines a multi-frame transport using [BC-UR](https://developer.blockchaincommons.com/ur/) fountain codes — small tokens render as a single static QR, larger tokens render as an animated sequence the receiver scans over several frames.

The package wraps [@gandlaf21/bc-ur](https://github.com/gandlafbtc/bc-ur) (the implementation cited by the NUT-16 spec) so encoding and decoding interop with Minibits, Cashu.me, and other NUT-16 wallets out of the box.

### Encode a Cashu V4 token for in-person handoff

```ts
import { encode } from 'imani-qr';

const result = encode(cashuBToken);
// or encode(cashuBToken, { maxFragmentLength: 100, frameIntervalMs: 200, forceAnimated: false });

if (result.mode === 'static') {
  // Render once with any QR library (existing lib/qrcode.min.js):
  new QRCode(container, { text: result.staticContent, width: 256, height: 256 });
} else {
  // Iterate frames on the cadence in result.frameIntervalMs:
  function tick() {
    const { value: frame } = result.frames.next();
    container.replaceChildren();
    new QRCode(container, { text: frame, width: 256, height: 256 });
    setTimeout(tick, result.frameIntervalMs);
  }
  tick();
}
```

The encoder is **headless** — it never touches the DOM. Rendering pixels stays with the caller's QR library so the package remains node-environment-testable.

### Receive an animated QR from another wallet

The scanner automatically detects UR fragments via `QrType.UR_FRAGMENT`, accumulates frames in an internal stateful decoder, and **emits the reconstructed cashuB token through the normal `scan` event** once the BC-UR fountain decoder reports completion. Existing scan listeners need no changes — they receive the reconstructed token identically to a single-frame cashuB scan.

To render scan-progress UI, subscribe to the new event channel:

```ts
scanner.onNut16Event((event) => {
  switch (event.kind) {
    case 'fragment-accepted':
      progressBar.value = event.progress.estimatedCompletion;
      label.textContent = `${event.progress.receivedCount} / ${event.progress.estimatedTotal} frames`;
      break;
    case 'reconstruction-complete':
      // Token already routed to the existing scan handler.
      hideProgressUI();
      break;
    case 'reconstruction-error':
      // Per-fragment CRC failure — session continues.
      flashErrorIndicator();
      break;
    case 'decoder-reset':
      hideProgressUI();
      break;
    case 'fragment-ignored':
      // Static QR or unrelated UR sequence — no action.
      break;
  }
});
```

The accumulator is reset automatically on `scanner.stop()` and camera-stop events — partial scan state does not persist across sessions.

### Programmatic decoder (for advanced use)

For headless decoding (no scanner), use `createDecoder()` directly:

```ts
import { createDecoder } from 'imani-qr';

const decoder = createDecoder();
for (const fragment of incomingUrFragments) {
  const status = decoder.receive(fragment);
  if (status.kind === 'complete') break;
}
if (decoder.isComplete()) {
  const cashuBToken = decoder.result();
}
```

## File Structure

```
src/
├── index.ts              # Package entry point
├── createQrScanner.ts    # Factory function
├── detector/
│   ├── QrTypeDetector.ts # Type detection logic
│   ├── types.ts          # QrType enum and interfaces
│   └── patterns.ts       # Regex patterns
├── scanner/
│   ├── QrScanner.ts      # qr-scanner wrapper
│   ├── CameraManager.ts  # Camera utilities
│   ├── ScanResult.ts     # Scan result class
│   └── ScannerConfig.ts  # Config resolution
├── handlers/
│   ├── HandlerRegistry.ts
│   ├── PaymentRequestHandler.ts
│   ├── TokenHandler.ts
│   └── IdentityHandler.ts
├── router/
│   ├── QrRouter.ts       # Route resolution
│   └── defaultRoutes.ts  # Default route configs
└── types/
    ├── scanner.ts        # Scanner config types
    └── routing.ts        # Route action types
```

## Browser Requirements

- Modern browser with camera/media APIs
- For best performance: Chrome, Edge, or Android (native BarcodeDetector)
- Falls back to WebWorker-based scanning on other browsers
- The `qr-scanner-worker.min.js` file must be accessible (placed alongside imani-qr.js)

## Compatibility

- **Target**: ES2020
- **Node**: 18+ (for tooling)
- **Browsers**: All modern browsers with camera support

## Migration from html5-qrcode

If upgrading from a previous version that used html5-qrcode:

1. Remove `html5-qrcode.min.js` from your HTML
2. Add `qr-scanner-worker.min.js` to your lib directory
3. Update imports: `Html5QrScanner` → `QrScanner` (alias still available for compatibility)
4. The API is largely compatible; main difference is `start()` creates the video element automatically

## Development

```bash
npm install          # Install dependencies
npm run build        # Build all formats
npm run typecheck    # TypeScript check
npm test             # Run tests
```
