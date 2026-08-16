import { describe, expect, it, vi } from 'vitest';
import { QrRouter } from '../src/router/QrRouter';
import { QrType } from '../src/detector';
import { PaymentRequestHandler } from '../src/handlers/PaymentRequestHandler';

const detection = (type: QrType, normalized: string) => ({
  type,
  raw: normalized,
  normalized
});

describe('QrRouter', () => {
  it('routes payment requests to send with params', () => {
    const router = new QrRouter();
    const action = router.route(detection(QrType.PAYMENT_REQUEST, 'vreqA123'));

    expect(action.type).toBe('navigate');
    expect(action.target).toBe('/customer/send.html');
    expect(action.params).toEqual({ paymentRequest: 'vreqA123' });
  });

  it('routes npub to profile modal', () => {
    const router = new QrRouter();
    const action = router.route(detection(QrType.NPUB, 'npub1abc'));

    expect(action.type).toBe('modal');
    expect(action.target).toBe('ProfileModal');
    expect(action.params).toEqual({ identifier: 'npub1abc' });
  });

  it('supports custom routes', () => {
    const router = new QrRouter({
      [QrType.CASHU_TOKEN]: { type: 'callback', target: 'redeem', paramKey: 'token' }
    });

    const action = router.route(detection(QrType.CASHU_TOKEN, 'cashuAabc'));
    expect(action.type).toBe('callback');
    expect(action.target).toBe('redeem');
    expect(action.params).toEqual({ token: 'cashuAabc' });
  });

  it('uses registered handler params when parsing', async () => {
    const router = new QrRouter();
    router.registerHandler(QrType.PAYMENT_REQUEST, new PaymentRequestHandler());

    const action = await router.parseWithHandler(
      detection(QrType.PAYMENT_REQUEST, 'vreqAxyz')
    );

    expect(action.params).toEqual({ paymentRequest: 'vreqAxyz' });
  });

  it('executes callback actions when handler provided', () => {
    const router = new QrRouter();
    const spy = vi.fn();

    router.execute({ type: 'callback', target: 'noop', params: {}, handler: spy });

    expect(spy).toHaveBeenCalled();
  });
});
