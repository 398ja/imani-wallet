import { QrTypeDetector } from './detector/QrTypeDetector.js';
import { QrScanner } from './scanner/QrScanner.js';
import { QrRouter } from './router/QrRouter.js';
import { HandlerRegistry } from './handlers/HandlerRegistry.js';
import { PaymentRequestHandler } from './handlers/PaymentRequestHandler.js';
import { IdentityHandler } from './handlers/IdentityHandler.js';
import { TokenHandler } from './handlers/TokenHandler.js';
import { QrType } from './detector/types.js';
import type { Nut16DecoderProgress, Nut16ScanEvent } from './nut16/types.js';
import type { RouteAction, RouteConfigMap } from './types/routing.js';
import type { ScannerConfig } from './types/scanner.js';
import type { DetectionResult } from './detector/types.js';

export interface CreateQrScannerOptions {
  scanner?: ScannerConfig;
  routes?: RouteConfigMap;
  onRoute?: (action: RouteAction) => void;
  /**
   * Spec 035 US3 (FR-013) — invoked as fragments of an animated NUT-16
   * QR are received. Use this to render scan-progress UI (e.g. "X parts
   * received"). Once reconstruction completes the assembled cashuB token
   * is routed through the normal CASHU_TOKEN path. NOT called for bare
   * (non-animated) tokens.
   *
   * Sourced from the SINGLE `Nut16ScanProcessor` instance owned by
   * `QrScanner` (see `scanner.onNut16Event`). Pre-spec-039 this module
   * also instantiated its own processor + ran a second decode pass; that
   * dead code was removed per FR-002 (single decoder per session).
   */
  onScanProgress?: (progress: Nut16DecoderProgress) => void;
  /**
   * Spec 039 US 1 (FR-001/002) — simplified progress callback. Receives
   * `{readCount, total}` per accepted NUT-16 fragment. Use this for the
   * scan-status copy ("N frames read (total M)"). When `total` is null
   * the fountain decoder hasn't yet committed to a part count.
   *
   * Sourced from the SAME `Nut16ScanProcessor` events as `onScanProgress`
   * — there is exactly one decoder per scan session (FR-002).
   */
  onProgress?: (progress: { readCount: number; total: number | null }) => void;
  autoExecute?: boolean;
}

export interface QrScannerInstance {
  scanner: QrScanner;
  detector: QrTypeDetector;
  router: QrRouter;
}

export function createQrScanner(options: CreateQrScannerOptions = {}): QrScannerInstance {
  const detector = new QrTypeDetector();

  const handlerRegistry = new HandlerRegistry({
    [QrType.PAYMENT_REQUEST]: new PaymentRequestHandler(),
    [QrType.CASHU_TOKEN]: new TokenHandler(),
    [QrType.NPUB]: new IdentityHandler(),
    [QrType.NIP05]: new IdentityHandler()
  });

  const router = new QrRouter(options.routes, handlerRegistry);
  const scanner = new QrScanner(options.scanner);

  // Spec 039 FR-002 — single decoder per scan session.
  //
  // Pre-spec-039 this module also instantiated `new Nut16ScanProcessor()`
  // and re-ran `processor.process(detection.raw)` inside the `onScan`
  // handler below. That code was DEAD: `QrScanner.handleScanSuccess`
  // already owns the only `Nut16ScanProcessor` instance and never
  // forwards a UR_FRAGMENT scan upward — `scanner.onScan(...)` only
  // fires for the assembled cashuB token (after reconstruction) or for
  // non-fountain QR. The second processor never observed a fragment.
  //
  // Spec 039 sources scan progress directly from QrScanner's
  // `'nut16'` event stream — the canonical single source of truth.
  scanner.onNut16Event((event: Nut16ScanEvent) => {
    if (event.kind !== 'fragment-accepted') return;
    options.onScanProgress?.(event.progress);
    const total =
      typeof event.progress.estimatedTotal === 'number' && event.progress.estimatedTotal > 0
        ? event.progress.estimatedTotal
        : null;
    options.onProgress?.({ readCount: event.progress.receivedCount, total });
  });

  scanner.onScan(async result => {
    // Post-spec-039: `result.raw` is either a non-fountain QR payload OR
    // the fully-reconstructed cashuB token (carrying
    // `metadata.nut16Reconstructed === true`). UR_FRAGMENT never reaches
    // this handler — QrScanner absorbs and accumulates fragments
    // internally until reconstruction.
    const detection: DetectionResult = detector.detect(result.raw);
    const action =
      (await router.parseWithHandler(detection)) ??
      router.route(detection);
    options.onRoute?.(action);
    if (options.autoExecute !== false) {
      router.execute(action);
    }
  });

  return { scanner, detector, router };
}
