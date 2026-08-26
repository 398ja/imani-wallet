/**
 * Vitest for retryOnTransientMintError (T012e).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TRANSIENT_RECEIVE_BACKOFFS_MS,
  RetryExhaustedError,
  retryOnTransientMintError,
} from './retryOnTransientMintError';

const transient = () => true;
const terminal = () => false;
const noSleep = () => Promise.resolve();

describe('retryOnTransientMintError', () => {
  it('returns the value on first-attempt success without sleeping', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fn = vi.fn(async () => 42);
    await expect(
      retryOnTransientMintError(fn, { isTransient: transient, sleep })
    ).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a transient error and eventually succeeds', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error('transient blip');
      return 'ok';
    };
    const sleep = vi.fn(() => Promise.resolve());
    await expect(
      retryOnTransientMintError(fn, { isTransient: transient, sleep })
    ).resolves.toBe('ok');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 4000);
  });

  it('uses the FR-016 backoff sequence by default', () => {
    expect(TRANSIENT_RECEIVE_BACKOFFS_MS).toEqual([1000, 4000, 15000]);
  });

  it('does NOT retry a terminal error', async () => {
    const terminalErr = new Error('already_spent');
    const fn = vi.fn(async () => {
      throw terminalErr;
    });
    const sleep = vi.fn(() => Promise.resolve());
    await expect(
      retryOnTransientMintError(fn, { isTransient: terminal, sleep })
    ).rejects.toBe(terminalErr);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws RetryExhaustedError when budget is exhausted on a transient error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('transient forever');
    });
    const sleep = vi.fn(() => Promise.resolve());
    await expect(
      retryOnTransientMintError(fn, { isTransient: transient, sleep })
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    // 1 initial + 3 retries = 4 attempts.
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('exhausted error carries the attempt count and the cause', async () => {
    const cause = new Error('upstream blip');
    const fn = async () => {
      throw cause;
    };
    try {
      await retryOnTransientMintError(fn, { isTransient: transient, sleep: noSleep });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RetryExhaustedError);
      expect((err as RetryExhaustedError).attempts).toBe(4);
      expect((err as RetryExhaustedError).cause).toBe(cause);
    }
  });

  it('honours a custom backoffs sequence', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw new Error('blip');
      return 'ok';
    };
    const sleep = vi.fn(() => Promise.resolve());
    await retryOnTransientMintError(fn, {
      isTransient: transient,
      sleep,
      backoffsMs: [50],
    });
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it('fires onRetry per retry with the attempt, delay, and error', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error(`blip-${calls}`);
      return 'ok';
    };
    const onRetry = vi.fn();
    await retryOnTransientMintError(fn, { isTransient: transient, sleep: noSleep, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, expect.objectContaining({ attempt: 1, delayMs: 1000 }));
    expect(onRetry).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2, delayMs: 4000 }));
  });

  it('swallows onRetry errors (telemetry is best-effort)', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw new Error('blip');
      return 'ok';
    };
    const onRetry = vi.fn(() => {
      throw new Error('telemetry blew up');
    });
    await expect(
      retryOnTransientMintError(fn, { isTransient: transient, sleep: noSleep, onRetry })
    ).resolves.toBe('ok');
    expect(onRetry).toHaveBeenCalled();
  });
});
