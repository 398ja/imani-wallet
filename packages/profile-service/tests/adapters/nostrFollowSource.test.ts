import { describe, it, expect, vi } from 'vitest';
import { NostrFollowSource } from '../../src/index.js';
import type { NostrEvent } from '../../src/adapters/NostrLookupAdapter.js';

const SELF = 'f'.repeat(64);
const OTHER = 'e'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function ev(p: Partial<NostrEvent>): NostrEvent {
  return { id: 'id1', pubkey: SELF, created_at: 100, kind: 3, tags: [], content: '', sig: 'sig', ...p };
}

function makeSource(opts: {
  events?: NostrEvent[];
  relays?: string[];
} = {}) {
  const publishEvent = vi.fn(async () => {});
  const sign = vi.fn(async (u: any): Promise<NostrEvent> => ({ ...u, id: 'signed', pubkey: SELF, sig: 'xx' }));
  const source = new NostrFollowSource({
    selfPubkey: SELF,
    query: async () => opts.events ?? [],
    sign,
    publishEvent,
    relays: opts.relays,
    now: () => 1_700_000_000_000,
  });
  return { source, publishEvent, sign };
}

describe('NostrFollowSource (spec 044 / T031)', () => {
  it('pull() returns the latest valid self-authored list, preserving metadata', async () => {
    const { source } = makeSource({
      events: [
        ev({ id: 'old', created_at: 100, tags: [['p', A]] }),
        ev({ id: 'new', created_at: 200, tags: [['p', A, 'wss://relay.staging.398ja.xyz', 'Alice'], ['p', B]] }),
      ],
    });
    const list = await source.pull();
    expect(list!.entries.map((e) => e.pubkey)).toEqual([A, B]);
    expect(list!.entries[0].relayHint).toBe('wss://relay.staging.398ja.xyz');
    expect(list!.entries[0].petname).toBe('Alice');
  });

  it('pull() ignores events authored by someone else', async () => {
    const { source } = makeSource({ events: [ev({ pubkey: OTHER, tags: [['p', A]] })] });
    expect(await source.pull()).toBeNull();
  });

  it('publish() signs + emits one kind-3 with empty content and metadata-preserving p-tags', async () => {
    const { source, publishEvent, sign } = makeSource();
    await source.publish([
      { pubkey: B, order: 2, relayHint: null, petname: null, createdAt: 0 },
      { pubkey: A, order: 1, relayHint: 'wss://relay.staging.398ja.xyz', petname: 'Alice', createdAt: 0 },
    ]);
    expect(sign).toHaveBeenCalledTimes(1);
    const unsigned = sign.mock.calls[0][0];
    expect(unsigned.kind).toBe(3);
    expect(unsigned.content).toBe('');
    expect(unsigned.tags[0]).toEqual(['p', A, 'wss://relay.staging.398ja.xyz', 'Alice']); // order-sorted
    expect(unsigned.tags[1]).toEqual(['p', B]);
    expect(publishEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects non-wss relays at construction (private relays only)', () => {
    expect(() => makeSource({ relays: ['ws://relay.example'] })).toThrow();
    expect(() => makeSource({ relays: ['https://relay.example'] })).toThrow();
    expect(() => makeSource({ relays: ['wss://relay.staging.398ja.xyz'] })).not.toThrow();
  });
});
