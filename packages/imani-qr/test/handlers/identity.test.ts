import { describe, expect, it } from 'vitest';
import { IdentityHandler } from '../../src/handlers/IdentityHandler';

describe('IdentityHandler', () => {
  it('validates and parses npub identifiers', async () => {
    const handler = new IdentityHandler();
    const npub = `npub1${'a'.repeat(58)}`;

    expect(handler.validate(npub)).toBe(true);

    const parsed = await handler.parse(npub);
    expect(parsed.identifier).toBe(npub);
    expect(parsed.kind).toBe('npub');
    expect(handler.getParams(parsed)).toEqual({ identifier: npub });
  });

  it('validates and parses nip05 identifiers', async () => {
    const handler = new IdentityHandler();
    const nip05 = 'user@example.com';

    expect(handler.validate(nip05)).toBe(true);

    const parsed = await handler.parse(nip05);
    expect(parsed.kind).toBe('nip05');
    expect(parsed.identifier).toBe(nip05);
  });
});
