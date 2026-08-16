import { describe, expect, it } from 'vitest';
import { TokenHandler } from '../../src/handlers/TokenHandler';

describe('TokenHandler', () => {
  it('validates and parses cashu tokens with or without URI prefix', async () => {
    const handler = new TokenHandler();

    expect(handler.validate('cashuAxyz')).toBe(true);
    expect(handler.validate('cashu:cashuBxyz')).toBe(true);
    expect(handler.validate('vreqA123')).toBe(false);

    const parsedA = await handler.parse('cashu:cashuA123');
    expect(parsedA.variant).toBe('cashuA');
    expect(parsedA.token).toBe('cashuA123');

    const parsedB = await handler.parse('cashuB456');
    expect(parsedB.variant).toBe('cashuB');
  });
});
