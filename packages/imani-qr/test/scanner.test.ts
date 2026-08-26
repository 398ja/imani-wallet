import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Html5QrScanner } from '../src/scanner';

class Html5QrcodeStub {
  static instances: Html5QrcodeStub[] = [];
  static cameras = [
    { id: 'cam-front', label: 'Front Camera' },
    { id: 'cam-back', label: 'Back Camera' }
  ];

  static getCameras = vi.fn(async () => Html5QrcodeStub.cameras);

  startCalls: Array<{ cameraConfig: unknown; config: unknown }> = [];
  onSuccess?: (text: string, result?: unknown) => void;
  onFailure?: (error: unknown) => void;
  stopped = false;
  pauseCalled = false;
  resumeCalled = false;

  constructor(public containerId: string) {
    Html5QrcodeStub.instances.push(this);
  }

  async start(cameraConfig: unknown, config: unknown, onSuccess: any, onFailure: any) {
    this.startCalls.push({ cameraConfig, config });
    this.onSuccess = onSuccess;
    this.onFailure = onFailure;
  }

  async stop() {
    this.stopped = true;
  }

  pause() {
    this.pauseCalled = true;
  }

  resume() {
    this.resumeCalled = true;
  }
}

const lastInstance = () => Html5QrcodeStub.instances[Html5QrcodeStub.instances.length - 1];

// TODO: tests are stale — they stub globalThis.Html5Qrcode but the
// scanner now uses the `qr-scanner` npm package. Needs a rewrite with
// a DOM env (happy-dom) and a proper `qr-scanner` mock.
describe.skip('Html5QrScanner', () => {
  beforeEach(() => {
    vi.useRealTimers();
    Html5QrcodeStub.instances = [];
    Html5QrcodeStub.getCameras.mockClear();
    (globalThis as any).Html5Qrcode = Html5QrcodeStub;
  });

  it('starts scanner and emits scan results', async () => {
    const scanner = new Html5QrScanner({ cooldownMs: 0 });
    const scans: string[] = [];
    const started = vi.fn();

    scanner.onScan(result => scans.push(result.raw));
    scanner.onStart(started);

    await scanner.start('container');

    const instance = lastInstance();
    instance.onSuccess?.('hello world');

    expect(started).toHaveBeenCalled();
    expect(scans).toEqual(['hello world']);
    expect(scanner.isRunning()).toBe(true);
  });

  it('prevents duplicate scans during cooldown window', async () => {
    vi.useFakeTimers();

    const scanner = new Html5QrScanner({ cooldownMs: 1000 });
    const scans: string[] = [];
    scanner.onScan(result => scans.push(result.raw));

    await scanner.start('container');

    const instance = lastInstance();
    await instance.onSuccess?.('repeat');
    await instance.onSuccess?.('repeat');
    expect(scans).toEqual(['repeat']);

    vi.advanceTimersByTime(1001);
    await instance.onSuccess?.('repeat');
    expect(scans).toEqual(['repeat', 'repeat']);

    vi.useRealTimers();
  });

  it('switches cameras by cycling available devices', async () => {
    const scanner = new Html5QrScanner();
    await scanner.start('container');

    const instance = lastInstance();
    expect(instance.startCalls[0].cameraConfig).toBe('cam-back'); // prefers environment/back camera

    await scanner.switchCamera();

    expect(instance.startCalls.length).toBe(2);
    expect(instance.startCalls[1].cameraConfig).toBe('cam-front');
    expect(instance.stopped).toBe(true);
  });

  it('supports pause and resume passthrough', async () => {
    const scanner = new Html5QrScanner();
    await scanner.start('container');
    const instance = lastInstance();

    scanner.pause();
    scanner.resume();

    expect(instance.pauseCalled).toBe(true);
    expect(instance.resumeCalled).toBe(true);
  });
});
