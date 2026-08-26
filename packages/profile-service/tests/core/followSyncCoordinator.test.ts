import { describe, it, expect, vi } from 'vitest';
import {
  FollowSyncCoordinator,
  type FollowLocalStore,
  type RemoteFollowSource,
  type RemoteFollowList,
} from '../../src/index.js';
import type { FollowEntry } from '../../src/index.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

/** Minimal in-memory FollowLocalStore for the coordinator. */
class FakeStore implements FollowLocalStore {
  map = new Map<string, FollowEntry>();
  seed(pk: string, syncState: FollowEntry['syncState'], order = 1): void {
    this.map.set(pk, {
      pubkey: pk, labels: [], createdAt: order, source: 'local', merchant: 'unknown',
      merchantCheckedAt: null, addedAt: order, order, syncState, relayHint: null, petname: null,
    });
  }
  async listEntries(): Promise<FollowEntry[]> { return Array.from(this.map.values()); }
  async add(pubkey: string, opts: { syncState?: FollowEntry['syncState']; order?: number; relayHint?: string | null; petname?: string | null } = {}): Promise<void> {
    const existing = this.map.get(pubkey);
    this.map.set(pubkey, {
      pubkey, labels: [], createdAt: existing?.createdAt ?? 1, source: 'local', merchant: existing?.merchant ?? 'unknown',
      merchantCheckedAt: existing?.merchantCheckedAt ?? null, addedAt: existing?.addedAt ?? 1,
      order: opts.order ?? existing?.order ?? 1, syncState: opts.syncState ?? existing?.syncState ?? 'synced',
      relayHint: opts.relayHint ?? existing?.relayHint ?? null, petname: opts.petname ?? existing?.petname ?? null,
    });
  }
  async remove(pubkey: string): Promise<void> { this.map.delete(pubkey); }
}

class FakeRemote implements RemoteFollowSource {
  published: FollowEntry['pubkey'][][] = [];
  constructor(private remoteList: RemoteFollowList | null) {}
  async pull(): Promise<RemoteFollowList | null> { return this.remoteList; }
  async publish(entries: ReadonlyArray<Pick<FollowEntry, 'pubkey' | 'order' | 'relayHint' | 'petname' | 'createdAt'>>): Promise<void> {
    this.published.push(entries.map((e) => e.pubkey));
  }
}

describe('FollowSyncCoordinator (spec 044 / T030)', () => {
  it('publishes a local pending-publish follow and marks it synced (pendingCount → 0)', async () => {
    const store = new FakeStore();
    store.seed(A, 'pending-publish');
    const remote = new FakeRemote(null); // no remote yet
    const onChange = vi.fn();
    const coord = new FollowSyncCoordinator({ store, remote, onChange, now: () => 999 });

    const state = await coord.syncNow();

    expect(remote.published).toHaveLength(1);
    expect(remote.published[0]).toContain(A);
    expect(store.map.get(A)!.syncState).toBe('synced');
    expect(state.pendingCount).toBe(0);
    expect(state.hydrated).toBe(true);
    expect(state.lastReconcileAt).toBe(999);
    expect(onChange).toHaveBeenCalled();
  });

  it('imports a remote-only follow locally as synced (cross-device)', async () => {
    const store = new FakeStore();
    const remote = new FakeRemote({ entries: [{ pubkey: B, relayHint: 'wss://relay.staging.398ja.xyz', petname: 'Bob' }], createdAt: 200, eventId: 'x' });
    const coord = new FollowSyncCoordinator({ store, remote });

    const state = await coord.syncNow();

    expect(store.map.has(B)).toBe(true);
    expect(store.map.get(B)!.syncState).toBe('synced');
    expect(store.map.get(B)!.relayHint).toBe('wss://relay.staging.398ja.xyz');
    expect(state.pendingCount).toBe(0);
  });

  it('drops a local synced follow that is absent from a present remote', async () => {
    const store = new FakeStore();
    store.seed(A, 'synced');
    store.seed(B, 'synced');
    const remote = new FakeRemote({ entries: [{ pubkey: A, relayHint: null, petname: null }], createdAt: 200, eventId: 'x' });
    const coord = new FollowSyncCoordinator({ store, remote });

    await coord.syncNow();

    expect(store.map.has(A)).toBe(true);
    expect(store.map.has(B)).toBe(false); // removed on another device
  });

  it('records a non-secret error category on failure without throwing', async () => {
    const store = new FakeStore();
    const remote: RemoteFollowSource = {
      pull: async () => { throw new TypeError('boom'); },
      publish: async () => {},
    };
    const coord = new FollowSyncCoordinator({ store, remote });
    const state = await coord.syncNow();
    expect(state.lastError).toBe('TypeError');
  });
});
