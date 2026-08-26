/**
 * Vitest for watermark helpers (T012).
 *
 * Covers data-model.md invariants:
 *   - Watermark stored as integer.
 *   - loadDmWatermark applies the 60s FR-007 buffer.
 *   - saveDmWatermark enforces monotonicity (lower write is a no-op).
 *   - Corrupt value yields null + a logged warning.
 *   - Negative / non-integer candidates throw.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  WATERMARK_BUFFER_SECONDS,
  WATERMARK_GRACE_SECONDS,
  loadDmWatermark,
  saveDmWatermark,
  watermarkKey,
} from './watermark';
import type { WatermarkStorage } from './watermark';

function memStorage(initial: Record<string, string> = {}): WatermarkStorage & {
  readonly data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem(key) {
      return key in data ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = value;
    },
  };
}

const USER = 'a'.repeat(64);
const KEY = `imani_dm_watermark:${USER}`;

describe('watermarkKey', () => {
  it('lowercases the pubkey', () => {
    expect(watermarkKey('A'.repeat(64))).toBe(KEY);
  });

  it('rejects empty input', () => {
    expect(() => watermarkKey('')).toThrow();
  });
});

describe('loadDmWatermark', () => {
  it('returns null for a fresh install (no stored value)', () => {
    expect(loadDmWatermark(USER, memStorage())).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(loadDmWatermark(USER, memStorage({ [KEY]: '' }))).toBeNull();
  });

  it('applies the 60s FR-007 buffer to the stored value', () => {
    const stored = 1_700_000_000;
    expect(loadDmWatermark(USER, memStorage({ [KEY]: String(stored) }))).toBe(
      stored - WATERMARK_BUFFER_SECONDS
    );
  });

  it('clamps the buffered value to >= 0 (early in epoch)', () => {
    expect(loadDmWatermark(USER, memStorage({ [KEY]: '10' }))).toBe(0);
    expect(loadDmWatermark(USER, memStorage({ [KEY]: '60' }))).toBe(0);
  });

  it('returns null + logs on a corrupt (non-numeric) value', () => {
    const warn = vi.fn();
    const result = loadDmWatermark(
      USER,
      memStorage({ [KEY]: 'NOT-AN-INTEGER' }),
      { warn }
    );
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith('[dmPoll] watermark-corrupt', expect.objectContaining({ key: KEY }));
  });

  it('returns null + logs on a negative value', () => {
    const warn = vi.fn();
    expect(loadDmWatermark(USER, memStorage({ [KEY]: '-1' }), { warn })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null + logs on a fractional value (would silently lose precision otherwise)', () => {
    const warn = vi.fn();
    expect(loadDmWatermark(USER, memStorage({ [KEY]: '1700.5' }), { warn })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('saveDmWatermark', () => {
  // Issue #304 — saveDmWatermark holds the stored value back by
  // WATERMARK_GRACE_SECONDS so a brief SSE disconnect cannot shift the
  // next catch-up query window past in-flight events. All write-path
  // assertions below account for the grace offset.

  it('writes (candidate - WATERMARK_GRACE_SECONDS) when no existing value', () => {
    const store = memStorage();
    const result = saveDmWatermark(USER, 1_700_000_000, store);
    expect(result).toBe(1_700_000_000 - WATERMARK_GRACE_SECONDS);
    expect(store.data[KEY]).toBe(String(1_700_000_000 - WATERMARK_GRACE_SECONDS));
  });

  it('overwrites when the graced candidate is strictly greater (monotonic advance)', () => {
    const store = memStorage({ [KEY]: '1699999900' });
    const result = saveDmWatermark(USER, 1_700_000_500, store);
    expect(result).toBe(1_700_000_500 - WATERMARK_GRACE_SECONDS);
    expect(store.data[KEY]).toBe(String(1_700_000_500 - WATERMARK_GRACE_SECONDS));
  });

  it('is a no-op when the graced candidate equals the existing value', () => {
    // existing = 1700000000, candidate - grace = 1700000000  → no-op
    const store = memStorage({ [KEY]: '1700000000' });
    const result = saveDmWatermark(USER, 1_700_000_000 + WATERMARK_GRACE_SECONDS, store);
    expect(result).toBe(1_700_000_000);
    expect(store.data[KEY]).toBe('1700000000');
  });

  it('is a no-op when the graced candidate is strictly less (monotonicity blocks regression)', () => {
    const store = memStorage({ [KEY]: '1700000000' });
    const result = saveDmWatermark(USER, 1_699_999_000, store);
    expect(result).toBe(1_700_000_000);
    expect(store.data[KEY]).toBe('1700000000');
  });

  it('Issue #304 — clamps the graced watermark to >= 0 (early-in-epoch candidate)', () => {
    const store = memStorage();
    const result = saveDmWatermark(USER, 10, store);
    expect(result).toBe(0);
    expect(store.data[KEY]).toBe('0');
  });

  it('Issue #304 — does NOT regress past a brief SSE disconnect window', () => {
    // Scenario: event A arrives at t=1000 and advances the stored value
    // to (1000 - grace) = 970. SSE drops. Event B was published at
    // t=985 — strictly inside the grace window. The next catch-up
    // query computes since = (stored - BUFFER) = (970 - 60) = 910 →
    // event B (createdAt 985) is still inside the query range and will
    // be re-fetched + dedup-handled.
    const store = memStorage();
    saveDmWatermark(USER, 1_000, store); // stored = 970
    const since = loadDmWatermark(USER, store)!;
    expect(since).toBe(1_000 - WATERMARK_GRACE_SECONDS - WATERMARK_BUFFER_SECONDS);
    expect(since).toBeLessThan(985); // event B's createdAt
  });

  it('throws RangeError on negative candidate', () => {
    expect(() => saveDmWatermark(USER, -1, memStorage())).toThrow(RangeError);
  });

  it('throws RangeError on non-integer candidate', () => {
    expect(() => saveDmWatermark(USER, 1.5, memStorage())).toThrow(RangeError);
  });

  it('throws RangeError on NaN', () => {
    expect(() => saveDmWatermark(USER, Number.NaN, memStorage())).toThrow(RangeError);
  });

  it('throws RangeError on Infinity', () => {
    expect(() => saveDmWatermark(USER, Number.POSITIVE_INFINITY, memStorage())).toThrow(RangeError);
  });

  it('overwrites a corrupt existing value (with a logged warning)', () => {
    const warn = vi.fn();
    const store = memStorage({ [KEY]: 'NOT-AN-INTEGER' });
    const result = saveDmWatermark(USER, 1_700_000_000, store, { warn });
    // Issue #304 — graced value is what gets persisted.
    expect(result).toBe(1_700_000_000 - WATERMARK_GRACE_SECONDS);
    expect(store.data[KEY]).toBe(String(1_700_000_000 - WATERMARK_GRACE_SECONDS));
    expect(warn).toHaveBeenCalledWith(
      '[dmPoll] watermark-corrupt',
      expect.objectContaining({ key: KEY, action: 'overwrite' })
    );
  });
});
