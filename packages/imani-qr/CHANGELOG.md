# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.5.1] - 2026-06-02

### Added

- **Spec 039 — `onProgress({readCount, total})`** option on
  `createQrScanner`. Simplified shape for the scan-status UI ("N frames
  read (total M)"). `total` is `null` until the fountain decoder commits
  to a part count. Fires per accepted NUT-16 fragment alongside the
  existing `onScanProgress` callback.

### Removed

- **Dead `Nut16ScanProcessor` second decoder** in `createQrScanner.ts`.
  Pre-spec-039 this module instantiated its own processor and ran a
  second decode pass inside the `onScan` handler. The code was DEAD —
  `QrScanner` owns the canonical processor and never forwards
  `UR_FRAGMENT` scans upward, so the second processor never observed a
  fragment. Removed per FR-002 (single decoder per scan session).

### Changed

- `createQrScanner` now sources NUT-16 progress events directly from
  `scanner.onNut16Event(...)` — the single source of truth — instead of
  re-decoding inside its `onScan` handler. No behavioural change for
  non-fountain QR (single-frame Cashu tokens, payment requests, npub,
  NIP-05). The IIFE bundle `lib/imani-qr.js` MUST be regenerated from
  this source on the next wallet release (spec-039 T054).

5-case vitest suite covers the new wiring + source-shape grep for the
single-decoder invariant. Full module suite: 109 / 109 green.

---

## [0.5.0] - 2026-05-28

Spec 035 — QR Scan & Redemption Reliability.

### Added
- `extractEmbeddedCashuToken(text)` in the detector — parses a scanned
  URL's query / fragment and returns a single embedded `cashuA` / `cashuB`
  token if exactly one valid candidate is found. Returns `null` for
  non-URLs, no-token URLs, and ambiguous (>1 candidate) URLs (FR-003).
- `QrTypeDetector.detect()` falls back to the new URL extractor when
  standard pattern matching returns `UNKNOWN`, so a scanned URL with one
  embedded token is treated as `CASHU_TOKEN` (`normalized` = the extracted
  inner token) — downstream routing never opens the long URL (avoids
  HTTP 414 for large tokens).
- `createQrScanner` exposes a new `onScanProgress(progress)` callback that
  fires as `Nut16ScanProcessor` accepts each animated-QR fragment
  (FR-013). Fields: `{ receivedCount, estimatedTotal, estimatedCompletion }`.
- `createQrScanner` now routes `UR_FRAGMENT` detections through
  `Nut16ScanProcessor`; on reconstruction the assembled `cashuB` token
  re-enters detection and routes via the standard `CASHU_TOKEN` path.

### Changed
- `defaultRoutes` `CASHU_TOKEN` route is now `type: 'callback'`
  (`target: 'handleCashuToken'`) instead of `type: 'navigate'` with
  `paramKey: 'token'`. The package router no longer embeds the raw token
  in the navigated URL; the navigating controller is now the single
  call-site responsible for storing a session handoff and building
  `?scan=<id>` (FR-001 / FR-004). Behavior change for any consumer that
  relied on the default auto-navigation with `?token=`; consumers that
  override the `CASHU_TOKEN` route (e.g. the `imani-apps` shell) are
  unaffected.
- `STATIC_BYTE_GUARD` lowered 400 → 240 to keep large vouchers comfortably
  inside the V10–V11 QR symbol band on the low-end Android baseline
  (Tecno / Itel-class) used in the launch market. The new value is
  documented inline; encode-threshold test asserts the boundary against
  the constant so a future ratchet stays green.

### Internal
- 13 new tests across `test/url-token-extract.test.ts`,
  `test/nut16/encode-threshold.test.ts`, and `test/nut16/scan-progress.test.ts`.
  Package vitest: 104 / 110 (6 skipped, 0 failed) — up from 85 at 0.4.0.


## [0.3.0] - 2026-01-31

### Changed
- Migrated from html5-qrcode to qr-scanner library for better performance

### Added
- `forceWorker` option to bypass BarcodeDetector API issues
