import { describe, expect, it, vi } from 'vitest';
import { PaymentRequestHandler } from '../../src/handlers/PaymentRequestHandler';

describe('PaymentRequestHandler', () => {
  it('validates and normalizes vreqA payment requests', async () => {
    const handler = new PaymentRequestHandler();

    expect(handler.validate('vreqA123')).toBe(true);
    expect(handler.validate('cashu:vreqA123')).toBe(true);
    expect(handler.validate('npub1')).toBe(false);

    const parsed = await handler.parse('cashu:vreqAfoo');
    expect(parsed.request).toBe('vreqAfoo');
  });

  it('uses global NUT18V parser when available', async () => {
    const handler = new PaymentRequestHandler();
    const parseSpy = vi.fn().mockReturnValue({ ok: true });
    (globalThis as any).NUT18V = { parse: parseSpy };

    const parsed = await handler.parse('vreqAbar');

    expect(parseSpy).toHaveBeenCalledWith('vreqAbar');
    expect(parsed.parsed).toEqual({ ok: true });
  });
});
