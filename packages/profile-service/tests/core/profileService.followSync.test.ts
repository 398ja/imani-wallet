import { describe, it, expect, vi } from 'vitest';
import {
  createProfileService,
  MemoryFollowAdapter,
  type RemoteFollowSource,
  type RemoteFollowList,
} from '../../src/index.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function makeService() {
  const followAdapter = new MemoryFollowAdapter();
  const service = createProfileService({
    // Follow-only test — lookup/directory are not exercised.
    lookupAdapter: { getProfile: async () => null, getProfiles: async () => new Map() } as any,
    directoryAdapter: { search: async () => ({ profiles: [], total: 0, hasMore: false }) } as any,
    followAdapter,
  } as any);
  return { service, followAdapter };
}

function fakeRemote(list: RemoteFollowList | null): RemoteFollowSource & { publish: ReturnType<typeof vi.fn> } {
  return {
    pull: async () => list,
    publish: vi.fn(async () => {}),
  };
}

describe('ProfileService follow sync wiring (spec 044 / T030 integration)', () => {
  it('startFollowSync imports a remote follow and listCustomers reflects it (cache invalidated)', async () => {
    const { service } = makeService();
    const remote = fakeRemote({ entries: [{ pubkey: B, relayHint: null, petname: null }], createdAt: 200, eventId: 'x' });

    // Prime the manager cache as empty, then sync.
    expect((await service.listCustomers()).length).toBe(0);
    const state = await service.startFollowSync(remote);

    expect(state.hydrated).toBe(true);
    const customers = (await service.listCustomers()).map((e) => e.pubkey);
    expect(customers).toContain(B);
  });

  it('a local follow is published on the next sync and marked synced', async () => {
    const { service } = makeService();
    const remote = fakeRemote(null);
    await service.startFollowSync(remote);

    await service.follow(A); // pending-publish
    const after = await service.syncFollowsNow();

    expect(remote.publish).toHaveBeenCalled();
    expect(remote.publish.mock.calls.at(-1)![0].map((e: any) => e.pubkey)).toContain(A);
    expect(after!.pendingCount).toBe(0);
    const entry = await service.getFollowEntry(A);
    expect(entry?.syncState).toBe('synced');
  });

  it('stopFollowSync drops sync without clearing the local store (FR-020)', async () => {
    const { service } = makeService();
    await service.startFollowSync(fakeRemote(null));
    await service.follow(A);
    service.stopFollowSync();

    expect(service.getFollowSyncState()).toBeNull();
    // Local follow is still there (cache preserved).
    expect(await service.isFollowing(A)).toBe(true);
  });
});
