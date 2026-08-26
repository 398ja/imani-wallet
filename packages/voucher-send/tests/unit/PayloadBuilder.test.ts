/**
 * PayloadBuilder — sender-side currency invariant tests.
 *
 * Covers test vectors TS-1 … TS-4 from
 * specs/007-fix-voucher-currency/contracts/token-transfer-dm.schema.md §3.
 *
 * Invariant S-INV-1: the outbound rumor MUST include a valid, uppercase,
 * non-`"UNKNOWN"` `face_unit`. If the sender's local voucher fails this check,
 * `PayloadBuilder.buildFromVoucher` throws and no DM is dispatched.
 */

import { describe, it, expect } from 'vitest';
import { PayloadBuilder, MissingFaceUnitError } from '../../src/transmission/PayloadBuilder';
import type { Voucher } from '../../src/types';

function makeVoucher(overrides: Partial<Voucher> = {}): Voucher {
  return {
    voucher_id: 'v-ts',
    token: 'cashuAeyJ...',
    face_value: 500,
    face_unit: 'USD',
    face_decimals: 2,
    token_amount: 780,
    backing_strategy: 'MINIMAL',
    status: 'active',
    ...overrides,
  };
}

describe('PayloadBuilder sender-side currency invariants (TS-1…TS-4)', () => {
  const builder = new PayloadBuilder();

  it('TS-1: known currency is forwarded verbatim', () => {
    const payload = builder.buildFromVoucher(makeVoucher({ face_unit: 'USD' }));
    expect(payload.faceUnit).toBe('USD');
  });

  it('TS-2: UNKNOWN sentinel refuses to build', () => {
    expect(() =>
      builder.buildFromVoucher(makeVoucher({ face_unit: 'UNKNOWN' as unknown as string }))
    ).toThrow(MissingFaceUnitError);
  });

  it('TS-3a: empty-string face_unit refuses to build', () => {
    expect(() =>
      builder.buildFromVoucher(makeVoucher({ face_unit: '' }))
    ).toThrow(MissingFaceUnitError);
  });

  it('TS-3b: null/undefined face_unit refuses to build', () => {
    expect(() =>
      builder.buildFromVoucher(makeVoucher({ face_unit: null as unknown as string }))
    ).toThrow(MissingFaceUnitError);
    expect(() =>
      builder.buildFromVoucher(makeVoucher({ face_unit: undefined as unknown as string }))
    ).toThrow(MissingFaceUnitError);
  });

  it('TS-4: lowercase "sat" is uppercased to "SAT"', () => {
    const payload = builder.buildFromVoucher(makeVoucher({ face_unit: 'sat' }));
    expect(payload.faceUnit).toBe('SAT');
  });
});
