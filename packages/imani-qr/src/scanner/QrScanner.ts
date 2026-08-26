import QrScannerLib from 'qr-scanner';
import { CameraManager } from './CameraManager.js';
import { ScanResult } from './ScanResult.js';
import { resolveScannerConfig } from './ScannerConfig.js';
import { QrType } from '../detector/types.js';
import { Nut16ScanProcessor } from '../nut16/scanProcessor.js';
import { UR_FRAGMENT_PATTERN, type Nut16ScanEvent } from '../nut16/types.js';
import type { ScannerConfig } from '../types/scanner.js';

type ScanListener = (result: ScanResult) => void;
type VoidListener = () => void;
type ErrorListener = (error: unknown) => void;
type Nut16Listener = (event: Nut16ScanEvent) => void;

interface EventMap {
  scan: Set<ScanListener>;
  start: Set<VoidListener>;
  stop: Set<VoidListener>;
  error: Set<ErrorListener>;
  nut16: Set<Nut16Listener>;
}

export class QrScanner {
  private scanner: QrScannerLib | null = null;
  private config: Required<ScannerConfig>;
  private cameraManager: CameraManager;
  private lastScanTime = 0;
  private lastScanText: string | null = null;
  private running = false;
  private videoElement: HTMLVideoElement | null = null;
  private containerId: string | null = null;
  private currentCameraIndex = 0;

  private nut16Processor = new Nut16ScanProcessor();

  private listeners: EventMap = {
    scan: new Set(),
    start: new Set(),
    stop: new Set(),
    error: new Set(),
    nut16: new Set()
  };

  constructor(config?: ScannerConfig, cameraManager = new CameraManager()) {
    this.config = resolveScannerConfig(config);
    this.cameraManager = cameraManager;

    // Force worker if configured (bypasses potentially buggy BarcodeDetector API)
    if (this.config.forceWorker) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (QrScannerLib as any)._disableBarcodeDetector = true;
    }
  }

  onScan(listener: ScanListener): () => void {
    this.listeners.scan.add(listener);
    return () => this.listeners.scan.delete(listener);
  }

  onStart(listener: VoidListener): () => void {
    this.listeners.start.add(listener);
    return () => this.listeners.start.delete(listener);
  }

  onStop(listener: VoidListener): () => void {
    this.listeners.stop.add(listener);
    return () => this.listeners.stop.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.listeners.error.add(listener);
    return () => this.listeners.error.delete(listener);
  }

  onNut16Event(listener: Nut16Listener): () => void {
    this.listeners.nut16.add(listener);
    return () => this.listeners.nut16.delete(listener);
  }

  /**
   * Start the scanner.
   * @param containerId - The ID of the container element where the video will be rendered.
   *                      qr-scanner will create a video element inside this container.
   */
  async start(containerId: string): Promise<void> {
    if (this.running) {
      return;
    }

    this.containerId = containerId;
    const container = document.getElementById(containerId);
    if (!container) {
      throw new Error(`Container element with id "${containerId}" not found`);
    }

    // Clear container using safe DOM methods
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    // Create video element for qr-scanner
    this.videoElement = document.createElement('video');
    this.videoElement.style.width = '100%';
    this.videoElement.style.height = '100%';
    this.videoElement.style.objectFit = 'cover';
    container.appendChild(this.videoElement);

    // Initialize qr-scanner
    this.scanner = new QrScannerLib(
      this.videoElement,
      result => this.handleScanSuccess(result.data),
      {
        onDecodeError: error => this.handleScanFailure(error),
        highlightScanRegion: true,
        highlightCodeOutline: true,
        maxScansPerSecond: this.config.fps,
        preferredCamera: this.config.preferredCamera === 'environment' ? 'environment' : 'user'
      }
    );

    try {
      await this.scanner.start();
      this.running = true;
      await this.emit('start');
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running || !this.scanner) {
      return;
    }

    try {
      this.scanner.stop();
      this.scanner.destroy();
    } catch {
      // Ignore stop errors
    } finally {
      this.cleanup();
      await this.emit('stop');
    }
  }

  pause(): void {
    if (this.scanner) {
      this.scanner.pause();
    }
  }

  resume(): void {
    if (this.scanner) {
      this.scanner.pause(false);
    }
  }

  async switchCamera(): Promise<void> {
    if (!this.scanner) {
      return;
    }

    const cameras = await QrScannerLib.listCameras(true);
    if (cameras.length <= 1) {
      return;
    }

    // Cycle to next camera
    this.currentCameraIndex = (this.currentCameraIndex + 1) % cameras.length;
    const nextCamera = cameras[this.currentCameraIndex];

    try {
      await this.scanner.setCamera(nextCamera.id);
    } catch (error) {
      this.emit('error', error);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Check if device has a camera
   */
  static async hasCamera(): Promise<boolean> {
    return QrScannerLib.hasCamera();
  }

  /**
   * List available cameras
   */
  static async listCameras(): Promise<Array<{ id: string; label: string }>> {
    return QrScannerLib.listCameras(true);
  }

  private cleanup(): void {
    this.running = false;
    this.lastScanText = null;
    this.scanner = null;

    const resetEvents = this.nut16Processor.reset();
    for (const event of resetEvents) {
      void this.emit('nut16', event);
    }

    if (this.videoElement && this.videoElement.parentNode) {
      this.videoElement.parentNode.removeChild(this.videoElement);
    }
    this.videoElement = null;
  }

  private shouldSkipScan(text: string): boolean {
    const now = Date.now();
    const withinCooldown = this.lastScanTime && now - this.lastScanTime < this.config.cooldownMs;

    if (withinCooldown && this.lastScanText && text === this.lastScanText) {
      return true;
    }

    if (withinCooldown && !this.lastScanText) {
      return true;
    }

    return false;
  }

  private handleScanSuccess = async (decodedText: string) => {
    const trimmed = decodedText.trim();

    if (UR_FRAGMENT_PATTERN.test(trimmed)) {
      const outcome = this.nut16Processor.process(trimmed);
      for (const event of outcome.events) {
        await this.emit('nut16', event);
      }
      if (outcome.kind === 'reconstructed') {
        this.lastScanTime = Date.now();
        this.lastScanText = outcome.cashuBToken;
        const result = new ScanResult(
          outcome.cashuBToken,
          outcome.cashuBToken,
          QrType.CASHU_TOKEN,
          { nut16Reconstructed: true }
        );
        await this.emit('scan', result);
        this.triggerFeedback();
      }
      return;
    }

    if (this.shouldSkipScan(decodedText)) {
      return;
    }

    const now = Date.now();
    this.lastScanTime = now;
    this.lastScanText = decodedText;

    const result = new ScanResult(trimmed, trimmed, QrType.UNKNOWN, {});

    await this.emit('scan', result);
    this.triggerFeedback();
  };

  private handleScanFailure = (error: unknown) => {
    // qr-scanner calls this frequently when no QR code is in view
    // Only emit for actual errors, not "No QR code found" messages
    if (error instanceof Error && error.message?.includes('No QR code found')) {
      return;
    }
    this.emit('error', error);
  };

  private triggerFeedback() {
    if (this.config.vibrate && typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(200);
      } catch {
        // Ignore vibration errors
      }
    }

    if (this.config.beep && typeof window !== 'undefined') {
      try {
        const AudioContextCtor =
          (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) {
          return;
        }
        const ctx = new AudioContextCtor();
        const oscillator = ctx.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, ctx.currentTime);
        oscillator.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.05);
      } catch {
        // Ignore audio errors
      }
    }
  }

  private async emit<T extends keyof EventMap>(event: T, payload?: unknown) {
    const listeners = this.listeners[event];
    if (!listeners?.size) {
      return;
    }

    for (const listener of listeners) {
      try {
        const result = (listener as (data?: unknown) => unknown)(payload);
        if (result instanceof Promise) {
          await result;
        }
      } catch {
        // Swallow listener errors to avoid stopping scanner
      }
    }
  }
}

// Keep Html5QrScanner as an alias for backward compatibility
export { QrScanner as Html5QrScanner };
