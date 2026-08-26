/**
 * Splitting Module Tests
 *
 * Tests for SplitPreviewService and SplitExecutor.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SplitPreviewService,
  createSplitPreviewService,
  SplitExecutor,
  createSplitExecutor,
} from '../src/splitting';
import type { Voucher, SplitPreview, SplitResult } from '../src/types';
import type { ApiAdapter } from '../src/adapters';

// ============================================================================
// Test Fixtures
// ============================================================================

function createVoucher(overrides: Partial<Voucher> = {}): Voucher {
  return {
    voucher_id: `voucher-${Math.random().toString(36).slice(2, 9)}`,
    token: 'cashuAtest...',
    face_value: 1000,
    face_unit: 'SAT',
    face_decimals: 0,
    token_amount: 1000,
    token_unit: 'sat',
    backing_strategy: 'LEGACY',
    issuer_id: 'merchant1',
    status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createApiAdapter(overrides: Partial<ApiAdapter> = {}): ApiAdapter {
  return {
    splitPreview: vi.fn().mockResolvedValue({
      canSplit: true,
      actualAmount: 500,
      roundingApplied: false,
      swapRequired: false,
    } as SplitPreview),
    splitExecute: vi.fn().mockResolvedValue({
      sendToken: 'cashuAsend...',
      keepToken: 'cashuAkeep...',
      sendFaceValue: 500,
      keepFaceValue: 500,
      sendTokenAmount: 500,
      keepTokenAmount: 500,
      faceUnit: 'SAT',
      faceDecimals: 0,
    } as SplitResult),
    resolveNip05: vi.fn(),
    getProfile: vi.fn(),
    sendDm: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// SplitPreviewService Tests
// ============================================================================

describe('SplitPreviewService', () => {
  describe('constructor', () => {
    it('creates with API adapter', () => {
      const api = createApiAdapter();
      const service = new SplitPreviewService(api);
      expect(service).toBeInstanceOf(SplitPreviewService);
    });
  });

  describe('createSplitPreviewService', () => {
    it('creates service instance', () => {
      const api = createApiAdapter();
      const service = createSplitPreviewService(api);
      expect(service).toBeInstanceOf(SplitPreviewService);
    });
  });

  describe('preview()', () => {
    let api: ApiAdapter;
    let service: SplitPreviewService;

    beforeEach(() => {
      api = createApiAdapter();
      service = new SplitPreviewService(api);
    });

    it('calls API with voucher token and amount', async () => {
      const voucher = createVoucher({ token: 'mytoken123' });

      await service.preview(voucher, 500);

      expect(api.splitPreview).toHaveBeenCalledWith('mytoken123', 500);
    });

    it('accepts token string directly', async () => {
      await service.preview('mytoken123', 500);

      expect(api.splitPreview).toHaveBeenCalledWith('mytoken123', 500);
    });

    it('returns preview result', async () => {
      const voucher = createVoucher();

      const result = await service.preview(voucher, 500);

      expect(result.canSplit).toBe(true);
      expect(result.actualAmount).toBe(500);
    });

    it('throws for voucher without token', async () => {
      const voucher = createVoucher({ token: undefined });

      await expect(service.preview(voucher, 500)).rejects.toThrow('Voucher has no token');
    });

    it('throws for zero amount', async () => {
      const voucher = createVoucher();

      await expect(service.preview(voucher, 0)).rejects.toThrow('Amount must be greater than 0');
    });

    it('throws for negative amount', async () => {
      const voucher = createVoucher();

      await expect(service.preview(voucher, -100)).rejects.toThrow('Amount must be greater than 0');
    });

    it('wraps API errors', async () => {
      api.splitPreview = vi.fn().mockRejectedValue(new Error('Network error'));
      const voucher = createVoucher();

      await expect(service.preview(voucher, 500)).rejects.toThrow('Split preview failed');
    });
  });

  describe('validate()', () => {
    let api: ApiAdapter;
    let service: SplitPreviewService;

    beforeEach(() => {
      api = createApiAdapter();
      service = new SplitPreviewService(api);
    });

    it('returns valid for sufficient balance', async () => {
      const voucher = createVoucher({ face_value: 1000 });

      const result = await service.validate(voucher, 500);

      expect(result.valid).toBe(true);
      expect(result.preview).toBeDefined();
    });

    it('returns invalid for zero amount', async () => {
      const voucher = createVoucher();

      const result = await service.validate(voucher, 0);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('greater than 0');
    });

    it('returns invalid for insufficient balance', async () => {
      const voucher = createVoucher({ face_value: 100 });

      const result = await service.validate(voucher, 500);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Insufficient balance');
    });

    it('returns valid without API call for exact balance', async () => {
      const voucher = createVoucher({ face_value: 500 });

      const result = await service.validate(voucher, 500);

      expect(result.valid).toBe(true);
      expect(api.splitPreview).not.toHaveBeenCalled();
    });

    it('returns invalid when canSplit is false', async () => {
      api.splitPreview = vi.fn().mockResolvedValue({
        canSplit: false,
        actualAmount: 0,
        error: 'Amount not splittable',
      });
      const voucher = createVoucher({ face_value: 1000 });

      const result = await service.validate(voucher, 500);

      expect(result.valid).toBe(false);
      // Uses the preview's error message if available
      expect(result.error).toContain('not splittable');
    });

    it('returns invalid when swap required', async () => {
      api.splitPreview = vi.fn().mockResolvedValue({
        canSplit: true,
        actualAmount: 500,
        swapRequired: true,
      });
      const voucher = createVoucher({ face_value: 1000 });

      const result = await service.validate(voucher, 500);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Swap required');
    });

    it('handles API errors gracefully', async () => {
      api.splitPreview = vi.fn().mockRejectedValue(new Error('Network error'));
      const voucher = createVoucher({ face_value: 1000 });

      const result = await service.validate(voucher, 500);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Network error');
    });
  });

  describe('requiresRounding()', () => {
    it('returns true when rounding applied', async () => {
      const api = createApiAdapter({
        splitPreview: vi.fn().mockResolvedValue({
          canSplit: true,
          actualAmount: 510,
          roundingApplied: true,
        }),
      });
      const service = new SplitPreviewService(api);
      const voucher = createVoucher();

      const result = await service.requiresRounding(voucher, 500);

      expect(result).toBe(true);
    });

    it('returns false when no rounding', async () => {
      const api = createApiAdapter();
      const service = new SplitPreviewService(api);
      const voucher = createVoucher();

      const result = await service.requiresRounding(voucher, 500);

      expect(result).toBe(false);
    });
  });

  describe('getActualAmount()', () => {
    it('returns actual amount from preview', async () => {
      const api = createApiAdapter({
        splitPreview: vi.fn().mockResolvedValue({
          canSplit: true,
          actualAmount: 512,
          roundingApplied: true,
        }),
      });
      const service = new SplitPreviewService(api);
      const voucher = createVoucher();

      const result = await service.getActualAmount(voucher, 500);

      expect(result).toBe(512);
    });
  });

  describe('getMinimumAmount()', () => {
    it('returns minSplitAmount from preview', async () => {
      const api = createApiAdapter({
        splitPreview: vi.fn().mockResolvedValue({
          canSplit: true,
          actualAmount: 1,
          minSplitAmount: 10,
        }),
      });
      const service = new SplitPreviewService(api);
      const voucher = createVoucher();

      const result = await service.getMinimumAmount(voucher);

      expect(result).toBe(10);
    });

    it('returns 1 when minSplitAmount not provided', async () => {
      const api = createApiAdapter();
      const service = new SplitPreviewService(api);
      const voucher = createVoucher();

      const result = await service.getMinimumAmount(voucher);

      expect(result).toBe(1);
    });

    it('returns 1 on error', async () => {
      const api = createApiAdapter({
        splitPreview: vi.fn().mockRejectedValue(new Error('Failed')),
      });
      const service = new SplitPreviewService(api);
      const voucher = createVoucher();

      const result = await service.getMinimumAmount(voucher);

      expect(result).toBe(1);
    });
  });
});

// ============================================================================
// SplitExecutor Tests
// ============================================================================

describe('SplitExecutor', () => {
  describe('constructor', () => {
    it('creates with API adapter', () => {
      const api = createApiAdapter();
      const executor = new SplitExecutor(api);
      expect(executor).toBeInstanceOf(SplitExecutor);
    });
  });

  describe('createSplitExecutor', () => {
    it('creates executor instance', () => {
      const api = createApiAdapter();
      const executor = createSplitExecutor(api);
      expect(executor).toBeInstanceOf(SplitExecutor);
    });
  });

  describe('execute()', () => {
    let api: ApiAdapter;
    let executor: SplitExecutor;

    beforeEach(() => {
      api = createApiAdapter();
      executor = new SplitExecutor(api);
    });

    it('executes split successfully', async () => {
      const voucher = createVoucher({ face_value: 1000 });

      const result = await executor.execute(voucher, 500);

      expect(result.sendToken).toBe('cashuAsend...');
      expect(result.keepToken).toBe('cashuAkeep...');
      expect(result.sendFaceValue).toBe(500);
      expect(result.keepFaceValue).toBe(500);
    });

    it('builds sentVoucher correctly', async () => {
      const voucher = createVoucher({
        face_value: 1000,
        face_unit: 'SAT',
        issuer_id: 'merchant1',
      });

      const result = await executor.execute(voucher, 500);

      expect(result.sentVoucher).toBeDefined();
      expect(result.sentVoucher.token).toBe('cashuAsend...');
      expect(result.sentVoucher.face_value).toBe(500);
      expect(result.sentVoucher.face_unit).toBe('SAT');
      expect(result.sentVoucher.issuer_id).toBe('merchant1');
      expect(result.sentVoucher.status).toBe('active');
    });

    it('builds keepVoucher correctly', async () => {
      const voucher = createVoucher({
        voucher_id: 'original-id',
        face_value: 1000,
        face_unit: 'SAT',
      });

      const result = await executor.execute(voucher, 500);

      expect(result.keepVoucher).toBeDefined();
      expect(result.keepVoucher.voucher_id).toBe('original-id');
      expect(result.keepVoucher.token).toBe('cashuAkeep...');
      expect(result.keepVoucher.face_value).toBe(500);
    });

    it('inherits source currency metadata when split response omits it', async () => {
      api.splitExecute = vi.fn().mockResolvedValue({
        sendToken: 'cashuAsend...',
        keepToken: 'cashuAkeep...',
        sendFaceValue: 500,
        keepFaceValue: 500,
        sendTokenAmount: 500,
        keepTokenAmount: 500,
        roundingApplied: false,
      } as SplitResult);
      const voucher = createVoucher({
        face_value: 1000,
        face_unit: 'USD',
        face_decimals: 2,
        backing_strategy: 'FULL',
        issuer_id: 'merchant-usd',
      });

      const result = await executor.execute(voucher, 500);

      expect(result.faceUnit).toBe('USD');
      expect(result.faceDecimals).toBe(2);
      expect(result.backingStrategy).toBe('FULL');
      expect(result.issuerId).toBe('merchant-usd');
      expect(result.sentVoucher.face_unit).toBe('USD');
      expect(result.sentVoucher.face_decimals).toBe(2);
      expect(result.keepVoucher.face_unit).toBe('USD');
      expect(result.keepVoucher.face_decimals).toBe(2);
    });

    it('includes memo in sentVoucher', async () => {
      const voucher = createVoucher();

      const result = await executor.execute(voucher, 500, { memo: 'Test payment' });

      expect(result.sentVoucher.memo).toBe('Test payment');
      expect(api.splitExecute).toHaveBeenCalledWith('cashuAtest...', 500, 'Test payment');
    });

    it('validates with preview by default', async () => {
      const voucher = createVoucher({ face_value: 1000 });

      await executor.execute(voucher, 500);

      expect(api.splitPreview).toHaveBeenCalled();
    });

    it('skips validation when skipValidation is true', async () => {
      const voucher = createVoucher({ face_value: 1000 });

      await executor.execute(voucher, 500, { skipValidation: true });

      expect(api.splitPreview).not.toHaveBeenCalled();
    });

    it('throws for voucher without token', async () => {
      const voucher = createVoucher({ token: undefined });

      await expect(executor.execute(voucher, 500)).rejects.toThrow('Voucher has no token');
    });

    it('throws for zero amount', async () => {
      const voucher = createVoucher();

      await expect(executor.execute(voucher, 0)).rejects.toThrow('Amount must be greater than 0');
    });

    it('throws for amount exceeding balance', async () => {
      const voucher = createVoucher({ face_value: 100 });

      await expect(executor.execute(voucher, 500)).rejects.toThrow();
    });

    it('throws when validation fails', async () => {
      api.splitPreview = vi.fn().mockResolvedValue({
        canSplit: false,
        error: 'Cannot split this token',
      });
      const voucher = createVoucher({ face_value: 1000 });

      await expect(executor.execute(voucher, 500)).rejects.toThrow();
    });

    it('throws swapRequired error for swap-related API errors', async () => {
      api.splitExecute = vi.fn().mockRejectedValue(new Error('swap required for this amount'));
      const voucher = createVoucher({ face_value: 1000 });

      await expect(executor.execute(voucher, 500, { skipValidation: true })).rejects.toThrow();
    });

    it('wraps generic API errors', async () => {
      api.splitExecute = vi.fn().mockRejectedValue(new Error('Network timeout'));
      const voucher = createVoucher({ face_value: 1000 });

      await expect(executor.execute(voucher, 500, { skipValidation: true })).rejects.toThrow(
        'Split failed: Network timeout'
      );
    });

    it('rejects a split when both result and source lack a usable face_unit', async () => {
      api.splitExecute = vi.fn().mockResolvedValue({
        sendToken: 'cashuAsend...',
        keepToken: 'cashuAkeep...',
        sendFaceValue: 500,
        keepFaceValue: 500,
        sendTokenAmount: 500,
        keepTokenAmount: 500,
        roundingApplied: false,
      } as SplitResult);
      const voucher = createVoucher({
        face_unit: undefined as unknown as string,
        face_decimals: undefined as unknown as number,
      });

      await expect(executor.execute(voucher, 500, { skipValidation: true })).rejects.toThrow(
        /face_unit/i
      );
    });
  });

  describe('splitForSend()', () => {
    it('returns token and voucher', async () => {
      const api = createApiAdapter();
      const executor = new SplitExecutor(api);
      const voucher = createVoucher({ face_value: 1000 });

      const result = await executor.splitForSend(voucher, 500);

      expect(result.token).toBe('cashuAsend...');
      expect(result.voucher).toBeDefined();
      expect(result.voucher.face_value).toBe(500);
    });

    it('passes memo to execute', async () => {
      const api = createApiAdapter();
      const executor = new SplitExecutor(api);
      const voucher = createVoucher({ face_value: 1000 });

      await executor.splitForSend(voucher, 500, 'Test memo');

      expect(api.splitExecute).toHaveBeenCalledWith(expect.any(String), 500, 'Test memo');
    });
  });

  describe('needsSplit()', () => {
    let executor: SplitExecutor;

    beforeEach(() => {
      const api = createApiAdapter();
      executor = new SplitExecutor(api);
    });

    it('returns true when amount < balance', () => {
      const voucher = createVoucher({ face_value: 1000 });

      expect(executor.needsSplit(voucher, 500)).toBe(true);
    });

    it('returns false when amount === balance', () => {
      const voucher = createVoucher({ face_value: 500 });

      expect(executor.needsSplit(voucher, 500)).toBe(false);
    });

    it('returns false when amount > balance', () => {
      const voucher = createVoucher({ face_value: 100 });

      expect(executor.needsSplit(voucher, 500)).toBe(false);
    });

    it('returns false for zero amount', () => {
      const voucher = createVoucher({ face_value: 1000 });

      expect(executor.needsSplit(voucher, 0)).toBe(false);
    });

    it('returns false for negative amount', () => {
      const voucher = createVoucher({ face_value: 1000 });

      expect(executor.needsSplit(voucher, -100)).toBe(false);
    });
  });

  describe('getTokenToSend()', () => {
    let api: ApiAdapter;
    let executor: SplitExecutor;

    beforeEach(() => {
      api = createApiAdapter();
      executor = new SplitExecutor(api);
    });

    it('returns original voucher when amount === balance', async () => {
      const voucher = createVoucher({ token: 'original-token', face_value: 500 });

      const result = await executor.getTokenToSend(voucher, 500);

      expect(result.token).toBe('original-token');
      expect(result.voucher).toBe(voucher);
      expect(result.wasSplit).toBe(false);
    });

    it('returns original voucher when amount > balance', async () => {
      const voucher = createVoucher({ token: 'original-token', face_value: 100 });

      const result = await executor.getTokenToSend(voucher, 500);

      expect(result.token).toBe('original-token');
      expect(result.wasSplit).toBe(false);
    });

    it('splits and returns new token when amount < balance', async () => {
      const voucher = createVoucher({ face_value: 1000 });

      const result = await executor.getTokenToSend(voucher, 500);

      expect(result.token).toBe('cashuAsend...');
      expect(result.voucher.face_value).toBe(500);
      expect(result.wasSplit).toBe(true);
    });

    it('passes memo when splitting', async () => {
      const voucher = createVoucher({ face_value: 1000 });

      await executor.getTokenToSend(voucher, 500, 'Payment memo');

      expect(api.splitExecute).toHaveBeenCalledWith(expect.any(String), 500, 'Payment memo');
    });
  });

  describe('voucher building', () => {
    it('copies merchant_metadata to sent voucher', async () => {
      const api = createApiAdapter();
      const executor = new SplitExecutor(api);
      const voucher = createVoucher({
        face_value: 1000,
        merchant_metadata: {
          merchant_name: 'Test Shop',
          merchant_logo: 'https://example.com/logo.png',
        },
      });

      const result = await executor.execute(voucher, 500);

      expect(result.sentVoucher.merchant_metadata).toEqual(voucher.merchant_metadata);
    });

    it('copies expires_at to both vouchers', async () => {
      const api = createApiAdapter();
      const executor = new SplitExecutor(api);
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const voucher = createVoucher({
        face_value: 1000,
        expires_at: futureDate,
      });

      const result = await executor.execute(voucher, 500);

      expect(result.sentVoucher.expires_at).toBe(futureDate);
      expect(result.keepVoucher.expires_at).toBe(futureDate);
    });

    // =======================================================================
    // Invariant: voucher expiry is set at purchase and maintained forever
    // until redemption or expiry. Split must NEVER mutate expires_at — the
    // sent and keep vouchers both carry the source's original expiry byte-
    // for-byte. Regression guard for the "expire bump on split" class of
    // bugs.
    // =======================================================================
    it('preserves the source expires_at byte-for-byte on a partial split', async () => {
      const api = createApiAdapter();
      const executor = new SplitExecutor(api);
      const originalExpiry = '2027-01-15T08:30:00.000Z';
      const voucher = createVoucher({
        face_value: 1000,
        expires_at: originalExpiry,
      });

      const result = await executor.execute(voucher, 250);

      expect(result.sentVoucher.expires_at).toBe(originalExpiry);
      expect(result.keepVoucher.expires_at).toBe(originalExpiry);
      // Stamped by construction, so it must match bit-for-bit.
      expect(result.sentVoucher.expires_at).toStrictEqual(voucher.expires_at);
      expect(result.keepVoucher.expires_at).toStrictEqual(voucher.expires_at);
    });

    it('does NOT rejuvenate an already-expired expires_at on split', async () => {
      const api = createApiAdapter();
      const executor = new SplitExecutor(api);
      // Deliberately in the past — split must not bump this forward.
      const pastExpiry = '2020-01-01T00:00:00.000Z';
      const voucher = createVoucher({
        face_value: 1000,
        expires_at: pastExpiry,
      });

      const result = await executor.execute(voucher, 500);

      expect(result.sentVoucher.expires_at).toBe(pastExpiry);
      expect(result.keepVoucher.expires_at).toBe(pastExpiry);
    });

    it('leaves expires_at undefined on output when source lacks one (no synthesis)', async () => {
      const api = createApiAdapter();
      const executor = new SplitExecutor(api);
      const voucher = createVoucher({ face_value: 1000 });
      delete (voucher as { expires_at?: string }).expires_at;

      const result = await executor.execute(voucher, 500);

      expect(result.sentVoucher.expires_at).toBeUndefined();
      expect(result.keepVoucher.expires_at).toBeUndefined();
    });

    it('copies mint_url to both vouchers', async () => {
      const api = createApiAdapter();
      const executor = new SplitExecutor(api);
      const voucher = createVoucher({
        face_value: 1000,
        mint_url: 'https://mint.example.com',
      });

      const result = await executor.execute(voucher, 500);

      expect(result.sentVoucher.mint_url).toBe('https://mint.example.com');
      expect(result.keepVoucher.mint_url).toBe('https://mint.example.com');
    });

    it('uses result values over source values when available', async () => {
      const api = createApiAdapter({
        splitPreview: vi.fn().mockResolvedValue({ canSplit: true, actualAmount: 500 }),
        splitExecute: vi.fn().mockResolvedValue({
          sendToken: 'cashuAsend...',
          keepToken: 'cashuAkeep...',
          sendFaceValue: 500,
          keepFaceValue: 500,
          sendTokenAmount: 500,
          keepTokenAmount: 500,
          faceUnit: 'USD',
          faceDecimals: 2,
          backingStrategy: 'BACKED',
          issuanceRatio: 0.95,
          issuerId: 'new-issuer',
        }),
      });
      const executor = new SplitExecutor(api);
      const voucher = createVoucher({
        face_value: 1000,
        face_unit: 'SAT',
        face_decimals: 0,
        backing_strategy: 'LEGACY',
        issuance_ratio: 1,
        issuer_id: 'old-issuer',
      });

      const result = await executor.execute(voucher, 500);

      // Should use values from result, not source
      expect(result.sentVoucher.face_unit).toBe('USD');
      expect(result.sentVoucher.face_decimals).toBe(2);
      expect(result.sentVoucher.backing_strategy).toBe('BACKED');
      expect(result.sentVoucher.issuance_ratio).toBe(0.95);
      expect(result.sentVoucher.issuer_id).toBe('new-issuer');
    });
  });
});
