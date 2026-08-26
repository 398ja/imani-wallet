import { describe, expect, it } from 'vitest';
import { HandlerRegistry } from '../../src/handlers/HandlerRegistry';
import { PaymentRequestHandler } from '../../src/handlers/PaymentRequestHandler';
import { TokenHandler } from '../../src/handlers/TokenHandler';
import { QrType } from '../../src/detector';

describe('HandlerRegistry', () => {
  it('registers and parses using handlers', async () => {
    const registry = new HandlerRegistry({
      [QrType.PAYMENT_REQUEST]: new PaymentRequestHandler(),
      [QrType.CASHU_TOKEN]: new TokenHandler()
    });

    const payment = await registry.parse(QrType.PAYMENT_REQUEST, 'vreqA123');
    expect(payment.params).toEqual({ paymentRequest: 'vreqA123' });

    const token = await registry.parse(QrType.CASHU_TOKEN, 'cashuAxyz');
    expect(token.params).toEqual({ token: 'cashuAxyz' });
  });

  it('throws when handler missing or validation fails', async () => {
    const registry = new HandlerRegistry();

    await expect(registry.parse(QrType.NPUB, 'npub1')).rejects.toThrow(/No handler/);

    registry.register(QrType.PAYMENT_REQUEST, new PaymentRequestHandler());
    await expect(registry.parse(QrType.PAYMENT_REQUEST, 'npub1')).rejects.toThrow(
      /failed validation/
    );
  });
});
