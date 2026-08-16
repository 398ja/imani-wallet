export interface QrBox {
  width: number;
  height: number;
}

export interface ScannerConfig {
  fps?: number;
  qrbox?: QrBox;
  aspectRatio?: number;
  preferredCamera?: 'environment' | 'user';
  cooldownMs?: number;
  vibrate?: boolean;
  beep?: boolean;
  /** Force use of Web Worker instead of native BarcodeDetector API */
  forceWorker?: boolean;
}

export const defaultConfig: Required<ScannerConfig> = {
  fps: 10,
  qrbox: { width: 250, height: 250 },
  aspectRatio: 1.0,
  preferredCamera: 'environment',
  cooldownMs: 2000,
  vibrate: true,
  beep: false,
  forceWorker: false
};
