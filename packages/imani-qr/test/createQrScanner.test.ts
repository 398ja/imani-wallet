import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQrScanner } from '../src/createQrScanner';
import { QrType } from '../src/detector';

class Html5QrcodeStub {
  static instances: Html5QrcodeStub[] = [];
  static getCameras = vi.fn(async () => [{ id: 'cam-back', label: 'Back Camera' }]);

  onSuccess?: (text: string) => void;

  constructor(public containerId: string) {
    Html5QrcodeStub.instances.push(this);
  }

  async start(_cameraConfig: unknown, _config: unknown, onSuccess: any) {
    this.onSuccess = onSuccess;
  }
}

// TODO: same as scanner.test.ts — needs DOM env + real `qr-scanner` mock.
describe.skip('createQrScanner', () => {
  beforeEach(() => {
    (globalThis as any).Html5Qrcode = Html5QrcodeStub;
    Html5QrcodeStub.instances = [];
    Html5QrcodeStub.getCameras.mockClear();
  });

  it('wires scanner to detector and router with onRoute callback', async () => {
    const onRoute = vi.fn();
    const { scanner } = createQrScanner({ onRoute, autoExecute: false });

    await scanner.start('container');

    const instance = Html5QrcodeStub.instances[0];
    await instance.onSuccess?.('vreqA123');

    expect(onRoute).toHaveBeenCalled();
    const action = onRoute.mock.calls[0][0];
    expect(action.params).toEqual({ paymentRequest: 'vreqA123' });
    expect(action.type).toBe('navigate');
  });

  it('registers default handlers for token and identity', async () => {
    const onRoute = vi.fn();
    const { scanner } = createQrScanner({ onRoute, autoExecute: false });

    await scanner.start('container');
    const instance = Html5QrcodeStub.instances[0];

    await instance.onSuccess?.('cashuAxyz');
    expect(onRoute.mock.calls[0][0].params).toEqual({ token: 'cashuAxyz' });

    onRoute.mockClear();
    await instance.onSuccess?.(`npub1${'a'.repeat(58)}`);
    expect(onRoute.mock.calls[0][0].params).toEqual({
      identifier: `npub1${'a'.repeat(58)}`
    });
  });
});
