/**
 * Vitest for runCatchupTick (T012d).
 *
 * Table-tests against FR-019 + multi-batch contract + same-second
 * pagination (T031). All deps mocked — pure-function discipline.
 */

import { describe, it, expect, vi } from 'vitest';
import { runCatchupTick, type CatchupNostrEvent, type CatchupTickDeps } from './runCatchupTick';
import type { EventOutcome } from './classifyEventOutcome';
import type { WatermarkStorage } from './watermark';
// Issue #304: the persisted watermark is held back by this grace window at
// save time, so the stored value is (maxCreatedAt - WATERMARK_GRACE_SECONDS).
import { WATERMARK_GRACE_SECONDS } from './watermark';

const USER = 'b'.repeat(64);
const KEY = `imani_dm_watermark:${USER}`;

function memStorage(initial: Record<string, string> = {}): WatermarkStorage & {
  readonly data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

function event(id: string, createdAt: number): CatchupNostrEvent {
  return {
    id,
    pubkey: 'fefe'.repeat(16),
    createdAt,
    kind: 1059,
    tags: [['p', USER]],
    content: 'enc',
    sig: '00'.repeat(64),
  };
}

function makeDeps(overrides: Partial<CatchupTickDeps>): CatchupTickDeps {
  const storage = memStorage();
  // Default: small now() + small lookback so test event timestamps don't
  // have to be Unix-epoch values. Override per-test as needed.
  return {
    userPubkeyHex: USER,
    queryEventsFn: vi.fn(async () => []),
    processFn: vi.fn(async () => ({ outcome: 'success' as EventOutcome }) as { outcome: Exclude<EventOutcome, 'duplicate_event'> }),
    watermarkStorage: storage,
    dedupHas: vi.fn(() => false),
    dedupAdd: vi.fn(),
    now: () => 50,
    freshInstallLookbackSeconds: 0,
    ...overrides,
  };
}

describe('runCatchupTick', () => {
  it('returns zero counts on an empty response', async () => {
    const queryEventsFn = vi.fn(async () => []);
    const deps = makeDeps({ queryEventsFn });
    const summary = await runCatchupTick(deps);
    expect(summary.processed).toBe(0);
    expect(summary.advanced).toBe(0);
    expect(summary.deferred).toBe(0);
    expect(summary.batches).toBe(1);
    expect(queryEventsFn).toHaveBeenCalledTimes(1);
  });

  it('on fresh install, queries with since = now - lookback', async () => {
    const queryEventsFn = vi.fn(async () => []);
    const deps = makeDeps({
      queryEventsFn,
      freshInstallLookbackSeconds: 600,
      now: () => 1_700_000_000,
    });
    await runCatchupTick(deps);
    expect(queryEventsFn).toHaveBeenCalledWith(
      expect.objectContaining({ since: 1_700_000_000 - 600 })
    );
  });

  it('on fresh install with default lookback, since = now - 7*86400', async () => {
    const queryEventsFn = vi.fn(async () => []);
    const deps: CatchupTickDeps = {
      userPubkeyHex: USER,
      queryEventsFn,
      processFn: vi.fn(async () => ({ outcome: 'success' as const })),
      watermarkStorage: memStorage(),
      dedupHas: vi.fn(() => false),
      dedupAdd: vi.fn(),
      now: () => 1_700_000_000,
      // no freshInstallLookbackSeconds override → default 7 days.
    };
    await runCatchupTick(deps);
    expect(queryEventsFn).toHaveBeenCalledWith(
      expect.objectContaining({ since: 1_700_000_000 - 7 * 86400 })
    );
  });

  it('uses the stored watermark (with 60s buffer) as the since cursor', async () => {
    const storage = memStorage({ [KEY]: '1700000000' });
    const queryEventsFn = vi.fn(async () => []);
    const deps = makeDeps({ queryEventsFn, watermarkStorage: storage });
    await runCatchupTick(deps);
    expect(queryEventsFn).toHaveBeenCalledWith(
      expect.objectContaining({ since: 1700000000 - 60 })
    );
  });

  it('processes events successfully and advances the watermark', async () => {
    const storage = memStorage();
    const events = [event('aa', 100), event('bb', 200), event('cc', 300)];
    const queryEventsFn = vi
      .fn<(args: { kinds: number[]; pTags: string[]; since: number; limit: number }) => Promise<CatchupNostrEvent[]>>()
      .mockResolvedValueOnce(events)
      .mockResolvedValueOnce([]);
    const dedupAdd = vi.fn();
    const deps = makeDeps({
      queryEventsFn,
      dedupAdd,
      watermarkStorage: storage,
      // makeDeps default: now=50, lookback=0 → since=50. All events (100..300) > since.
    });
    const summary = await runCatchupTick(deps);
    expect(summary.processed).toBe(3);
    expect(summary.advanced).toBe(3);
    expect(summary.deferred).toBe(0);
    expect(dedupAdd).toHaveBeenCalledTimes(3);
    expect(storage.data[KEY]).toBe(String(300 - WATERMARK_GRACE_SECONDS));
  });

  it('dedup gate suppresses already-processed events (no processFn call)', async () => {
    const events = [event('aa', 100), event('bb', 200)];
    const dedupHas = vi.fn((id: string) => id === 'aa');
    const processFn = vi.fn(async () => ({ outcome: 'success' as const }));
    const deps = makeDeps({
      queryEventsFn: vi.fn().mockResolvedValueOnce(events).mockResolvedValueOnce([]),
      dedupHas,
      processFn,
    });
    const summary = await runCatchupTick(deps);
    expect(summary.deduped).toBe(1);
    expect(processFn).toHaveBeenCalledTimes(1);
    expect(processFn).toHaveBeenCalledWith(expect.objectContaining({ id: 'bb' }));
  });

  it('FR-019: transient receive failure breaks the batch and does NOT advance the watermark past that event', async () => {
    const storage = memStorage();
    const events = [event('aa', 100), event('bb', 200), event('cc', 300)];
    const processFn = vi.fn(async (e: CatchupNostrEvent) => {
      if (e.id === 'bb') return { outcome: 'transient_receive_within_budget' as const };
      return { outcome: 'success' as const };
    });
    const deps = makeDeps({
      queryEventsFn: vi.fn().mockResolvedValueOnce(events).mockResolvedValueOnce([]),
      processFn,
      watermarkStorage: storage,
    });
    const summary = await runCatchupTick(deps);
    // aa processed; bb deferred → loop breaks; cc not attempted (next tick picks up).
    expect(summary.processed).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(processFn).toHaveBeenCalledTimes(2);
    // Watermark capped at aa's createdAt (NOT advanced past bb).
    expect(storage.data[KEY]).toBe(String(100 - WATERMARK_GRACE_SECONDS));
  });

  it('FR-019: malformed payload advances the watermark + marks processed', async () => {
    const storage = memStorage();
    const events = [event('aa', 100)];
    const processFn = vi.fn(async () => ({ outcome: 'malformed_payload' as const }));
    const dedupAdd = vi.fn();
    const deps = makeDeps({
      queryEventsFn: vi.fn().mockResolvedValueOnce(events).mockResolvedValueOnce([]),
      processFn,
      dedupAdd,
      watermarkStorage: storage,
    });
    const summary = await runCatchupTick(deps);
    expect(summary.processed).toBe(0);
    expect(summary.advanced).toBe(1);
    expect(dedupAdd).toHaveBeenCalledWith('aa');
    expect(storage.data[KEY]).toBe(String(100 - WATERMARK_GRACE_SECONDS));
  });

  it('FR-019: terminal receive failure advances the watermark + marks processed (surfaced to user)', async () => {
    const storage = memStorage();
    const events = [event('aa', 100)];
    const processFn = vi.fn(async () => ({ outcome: 'terminal_receive' as const }));
    const dedupAdd = vi.fn();
    const deps = makeDeps({
      queryEventsFn: vi.fn().mockResolvedValueOnce(events).mockResolvedValueOnce([]),
      processFn,
      dedupAdd,
      watermarkStorage: storage,
    });
    const summary = await runCatchupTick(deps);
    expect(summary.advanced).toBe(1);
    expect(dedupAdd).toHaveBeenCalledWith('aa');
    expect(storage.data[KEY]).toBe(String(100 - WATERMARK_GRACE_SECONDS));
  });

  it('FR-019: atomic write failure does NOT advance the watermark + does NOT mark processed', async () => {
    const storage = memStorage();
    const events = [event('aa', 100)];
    const processFn = vi.fn(async () => ({ outcome: 'atomic_write_failed' as const }));
    const dedupAdd = vi.fn();
    const deps = makeDeps({
      queryEventsFn: vi.fn().mockResolvedValueOnce(events).mockResolvedValueOnce([]),
      processFn,
      dedupAdd,
      watermarkStorage: storage,
    });
    const summary = await runCatchupTick(deps);
    expect(summary.deferred).toBe(1);
    expect(dedupAdd).not.toHaveBeenCalled();
    expect(storage.data[KEY]).toBeUndefined();
  });

  it('multi-batch: fires follow-up query with since = max(createdAt) when first batch fills the limit', async () => {
    const storage = memStorage();
    const batch1 = Array.from({ length: 50 }, (_, i) => event(`a${i}`, 100 + i));
    const batch2 = [event('z', 200)];
    const queryEventsFn = vi
      .fn<(args: { kinds: number[]; pTags: string[]; since: number; limit: number }) => Promise<CatchupNostrEvent[]>>()
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2);
    const deps = makeDeps({
      queryEventsFn,
      watermarkStorage: storage,
      batchLimit: 50,
    });
    await runCatchupTick(deps);
    // Two batches: batch1 (50 = limit, continue) then batch2 (1 < limit, terminate).
    expect(queryEventsFn).toHaveBeenCalledTimes(2);
    // Second call's since must equal the max createdAt of batch1 (149), NOT +1.
    expect(queryEventsFn.mock.calls[1][0].since).toBe(149);
  });

  it('same-second pagination: 51 events all at the same createdAt, limit 50 — second batch fetches the spillover via dedup-suppressed boundary', async () => {
    const storage = memStorage();
    const sameSecond = 100;
    const batch1 = Array.from({ length: 50 }, (_, i) => event(`a${String(i).padStart(2, '0')}`, sameSecond));
    const batch2 = [
      // The gateway sorts by (createdAt asc, id asc), so the follow-up batch at
      // since=100 returns the boundary set including a00..a49 + the spillover.
      // Our dedup gate suppresses the already-processed ones.
      ...batch1,
      event('a50', sameSecond),
    ];
    const queryEventsFn = vi
      .fn<(args: { kinds: number[]; pTags: string[]; since: number; limit: number }) => Promise<CatchupNostrEvent[]>>()
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce([]);

    // Real dedup set: tracks processed event ids.
    const processedSet = new Set<string>();
    const dedupHas = vi.fn((id: string) => processedSet.has(id));
    const dedupAdd = vi.fn((id: string) => {
      processedSet.add(id);
    });
    const processFn = vi.fn(async () => ({ outcome: 'success' as const }));

    const deps = makeDeps({
      queryEventsFn,
      dedupHas,
      dedupAdd,
      processFn,
      watermarkStorage: storage,
      batchLimit: 50,
    });
    const summary = await runCatchupTick(deps);

    // All 51 unique events processed exactly once.
    expect(summary.processed).toBe(51);
    expect(processFn).toHaveBeenCalledTimes(51);
    // 50 boundary events deduped on the second batch.
    expect(summary.deduped).toBe(50);
    // Second-batch query uses since = sameSecond (NOT sameSecond + 1).
    expect(queryEventsFn.mock.calls[1][0].since).toBe(sameSecond);
    // Watermark advances to sameSecond (held back by the Issue #304 grace).
    expect(storage.data[KEY]).toBe(String(sameSecond - WATERMARK_GRACE_SECONDS));
  });

  it('terminates the multi-batch loop after maxBatchesPerTick', async () => {
    // Realistic scenario for the maxBatchesPerTick cap: each batch DOES
    // make progress (createdAts strictly increasing) so the no-progress
    // termination (Copilot review #296 — C) doesn't fire first. Without
    // the cap, this 4-batch firehose would keep going; with cap=3, we
    // bail after 3.
    const queryEventsFn = vi
      .fn<(args: { kinds: number[]; pTags: string[]; since: number; limit: number }) => Promise<CatchupNostrEvent[]>>()
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => event(`a${i}`, 100 + i)))
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => event(`b${i}`, 200 + i)))
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => event(`c${i}`, 300 + i)))
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => event(`d${i}`, 400 + i)));
    const dedupHas = vi.fn(() => false);
    const dedupAdd = vi.fn();
    const processFn = vi.fn(async () => ({ outcome: 'success' as const }));
    const deps = makeDeps({
      queryEventsFn,
      dedupHas,
      dedupAdd,
      processFn,
      batchLimit: 50,
      maxBatchesPerTick: 3,
    });
    const summary = await runCatchupTick(deps);
    expect(summary.batches).toBe(3);
    expect(queryEventsFn).toHaveBeenCalledTimes(3);
  });

  it('no-progress termination — Copilot review #296 (C): same-batch loop bails after one repeat', async () => {
    // Pathological scenario: gateway keeps returning the same 50 events
    // even though all are already deduped. Without the no-progress
    // guard the loop would hit maxBatchesPerTick (default 20) of
    // wasted gateway calls. With the guard it terminates after the
    // first repeat batch.
    const sameBatch = Array.from({ length: 50 }, (_, i) => event(`a${i}`, 100 + i));
    const queryEventsFn = vi
      .fn<(args: { kinds: number[]; pTags: string[]; since: number; limit: number }) => Promise<CatchupNostrEvent[]>>()
      .mockResolvedValue(sameBatch);
    const processedSet = new Set<string>();
    const dedupHas = vi.fn((id: string) => processedSet.has(id));
    const dedupAdd = vi.fn((id: string) => { processedSet.add(id); });
    const processFn = vi.fn(async () => ({ outcome: 'success' as const }));
    const deps = makeDeps({
      queryEventsFn,
      dedupHas,
      dedupAdd,
      processFn,
      batchLimit: 50,
      maxBatchesPerTick: 20,
    });
    const summary = await runCatchupTick(deps);
    // batch1: process 50 → since advances to 149.
    // batch2: dedup gate suppresses all 50, max createdAt stays at 149 →
    //         no-progress guard fires → terminate. Total 2 batches, not 20.
    expect(summary.batches).toBe(2);
    expect(queryEventsFn).toHaveBeenCalledTimes(2);
    expect(summary.deduped).toBe(50);
  });

  it('treats an uncaught processFn throw as transient (defensive)', async () => {
    const events = [event('aa', 100)];
    const processFn = vi.fn(async () => {
      throw new Error('uncaught bridge error');
    });
    const warn = vi.fn();
    const deps = makeDeps({
      queryEventsFn: vi.fn().mockResolvedValueOnce(events).mockResolvedValueOnce([]),
      processFn,
      logger: { warn },
    });
    const summary = await runCatchupTick(deps);
    expect(summary.deferred).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '[dmPoll] catchup-process-uncaught',
      expect.objectContaining({ eventId: 'aa' })
    );
  });
});
