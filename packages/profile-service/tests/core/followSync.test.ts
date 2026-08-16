import { describe, it, expect } from 'vitest';
import {
  parseContactListEvent,
  pickLatestValid,
  buildContactListTags,
  reconcile,
  type RemoteFollowList,
} from '../../src/index.js';
import type { FollowEntry } from '../../src/index.js';
import type { NostrEvent } from '../../src/adapters/NostrLookupAdapter.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const SELF = 'f'.repeat(64);
const OTHER = 'e'.repeat(64);

function ev(p: Partial<NostrEvent>): NostrEvent {
  return { id: 'id1', pubkey: SELF, created_at: 100, kind: 3, tags: [], content: '', sig: 'sig', ...p };
}

function fe(p: Partial<FollowEntry> & { pubkey: string }): FollowEntry {
  return {
    labels: [], createdAt: 1, source: 'local', merchant: 'unknown', merchantCheckedAt: null,
    addedAt: 1, order: 1, syncState: 'synced', relayHint: null, petname: null, ...p,
  };
}

describe('followSync — NIP-02 parse + validation (spec 044 / T041)', () => {
  it('parses a valid kind-3 by the expected author, preserving relay hint + petname', () => {
    const list = parseContactListEvent(
      ev({ tags: [['p', A, 'wss://relay.staging.398ja.xyz', 'Alice'], ['p', B]] }),
      SELF
    );
    expect(list).not.toBeNull();
    expect(list!.entries.map((e) => e.pubkey)).toEqual([A, B]);
    expect(list!.entries[0].relayHint).toBe('wss://relay.staging.398ja.xyz');
    expect(list!.entries[0].petname).toBe('Alice');
    expect(list!.entries[1].relayHint).toBeNull();
  });

  it('rejects wrong author / wrong kind / failed signature', () => {
    expect(parseContactListEvent(ev({ pubkey: OTHER, tags: [['p', A]] }), SELF)).toBeNull();
    expect(parseContactListEvent(ev({ kind: 1, tags: [['p', A]] }), SELF)).toBeNull();
    expect(parseContactListEvent(ev({ tags: [['p', A]] }), SELF, () => false)).toBeNull();
  });

  it('drops malformed p tags but keeps valid ones, and collapses duplicates', () => {
    const list = parseContactListEvent(
      ev({ tags: [['p', 'not-hex'], ['p', A], ['p', A], ['e', B], ['p', C]] }),
      SELF
    );
    expect(list!.entries.map((e) => e.pubkey)).toEqual([A, C]);
  });

  it('distinguishes a valid empty list from no event', () => {
    const empty = parseContactListEvent(ev({ tags: [] }), SELF);
    expect(empty).not.toBeNull();
    expect(empty!.entries).toEqual([]);
    expect(parseContactListEvent(null, SELF)).toBeNull();
  });

  it('pickLatestValid uses created_at then deterministic event-id tie-break', () => {
    const older = ev({ id: 'z', created_at: 100, tags: [['p', A]] });
    const newer = ev({ id: 'a', created_at: 200, tags: [['p', B]] });
    expect(pickLatestValid([older, newer], SELF)!.entries[0].pubkey).toBe(B);

    const tieLow = ev({ id: 'aaa', created_at: 200, tags: [['p', A]] });
    const tieHigh = ev({ id: 'bbb', created_at: 200, tags: [['p', B]] });
    // Same created_at → higher event id wins, deterministically.
    expect(pickLatestValid([tieLow, tieHigh], SELF)!.entries[0].pubkey).toBe(B);

    expect(pickLatestValid([ev({ pubkey: OTHER, tags: [['p', A]] })], SELF)).toBeNull();
  });
});

describe('followSync — NIP-02 build + metadata round-trip (spec 044 / T042 / SC-008)', () => {
  it('builds p-tags sorted by order with empty content semantics + preserved metadata', () => {
    const tags = buildContactListTags([
      { pubkey: B, order: 2, relayHint: null, petname: null, createdAt: 0 },
      { pubkey: A, order: 1, relayHint: 'wss://relay.staging.398ja.xyz', petname: 'Alice', createdAt: 0 },
      { pubkey: C, order: 3, relayHint: null, petname: 'Carol', createdAt: 0 },
    ]);
    expect(tags[0]).toEqual(['p', A, 'wss://relay.staging.398ja.xyz', 'Alice']);
    expect(tags[1]).toEqual(['p', B]);
    expect(tags[2]).toEqual(['p', C, '', 'Carol']); // petname, no relay
  });

  it('round-trips relay hints + petnames through build → parse', () => {
    const tags = buildContactListTags([
      { pubkey: A, order: 1, relayHint: 'wss://relay.staging.398ja.xyz', petname: 'Alice', createdAt: 0 },
    ]);
    const parsed = parseContactListEvent(ev({ tags }), SELF)!;
    expect(parsed.entries[0]).toEqual({ pubkey: A, relayHint: 'wss://relay.staging.398ja.xyz', petname: 'Alice' });
  });
});

describe('followSync — reconcile / convergence (spec 044 / T028 / R2)', () => {
  it('no remote + pending → shouldPublish, pendingCount reflects pending', () => {
    const r = reconcile([fe({ pubkey: A, syncState: 'pending-publish' })], null);
    expect(r.shouldPublish).toBe(true);
    expect(r.pendingCount).toBe(1);
  });

  it('remote baseline imports as synced upserts (other-device follow appears)', () => {
    const remote: RemoteFollowList = {
      entries: [{ pubkey: A, relayHint: 'wss://relay.staging.398ja.xyz', petname: 'Alice' }],
      createdAt: 200, eventId: 'x',
    };
    const r = reconcile([], remote);
    expect(r.upserts.map((u) => u.pubkey)).toEqual([A]);
    expect(r.upserts[0].relayHint).toBe('wss://relay.staging.398ja.xyz');
    expect(r.removes).toEqual([]);
  });

  it('local pending-publish absent from remote is preserved + triggers publish', () => {
    const remote: RemoteFollowList = { entries: [{ pubkey: A, relayHint: null, petname: null }], createdAt: 200, eventId: 'x' };
    const r = reconcile([fe({ pubkey: B, syncState: 'pending-publish' })], remote);
    expect(r.removes).not.toContain(B); // merge bias: don't drop the new follow
    expect(r.shouldPublish).toBe(true);
  });

  it('local synced entry absent from a present remote is removed (other-device unfollow)', () => {
    const remote: RemoteFollowList = { entries: [{ pubkey: A, relayHint: null, petname: null }], createdAt: 200, eventId: 'x' };
    const r = reconcile([fe({ pubkey: A, syncState: 'synced' }), fe({ pubkey: B, syncState: 'synced' })], remote);
    expect(r.removes).toEqual([B]);
  });

  it('local pending-removal is dropped locally + triggers publish', () => {
    const remote: RemoteFollowList = { entries: [{ pubkey: A, relayHint: null, petname: null }], createdAt: 200, eventId: 'x' };
    const r = reconcile([fe({ pubkey: A, syncState: 'pending-removal' })], remote);
    expect(r.removes).toContain(A);
    expect(r.shouldPublish).toBe(true);
  });

  it('fully synced + no pending ⇒ equivalent (pendingCount 0, no publish)', () => {
    const remote: RemoteFollowList = { entries: [{ pubkey: A, relayHint: null, petname: null }], createdAt: 200, eventId: 'x' };
    const r = reconcile([fe({ pubkey: A, syncState: 'synced' })], remote);
    expect(r.pendingCount).toBe(0);
    expect(r.shouldPublish).toBe(false);
  });

  it('steady state (synced + matching order/metadata) emits ZERO upserts — no write/render churn [PR #345 review]', () => {
    const remote: RemoteFollowList = {
      entries: [{ pubkey: A, relayHint: 'wss://relay.staging.398ja.xyz', petname: 'Al' }],
      createdAt: 200,
      eventId: 'x',
    };
    const r = reconcile(
      [fe({ pubkey: A, syncState: 'synced', order: 0, relayHint: 'wss://relay.staging.398ja.xyz', petname: 'Al' })],
      remote
    );
    expect(r.upserts).toEqual([]);
    expect(r.removes).toEqual([]);
    expect(r.shouldPublish).toBe(false);
  });

  it('re-emits an upsert only when a remote entry actually differs (order/petname/not-yet-synced)', () => {
    const remote: RemoteFollowList = { entries: [{ pubkey: A, relayHint: null, petname: 'New' }], createdAt: 200, eventId: 'x' };
    // stale petname + non-zero order → must upsert to converge (order → idx 0).
    const r1 = reconcile([fe({ pubkey: A, syncState: 'synced', order: 5, petname: 'Old' })], remote);
    expect(r1.upserts.map((u) => u.pubkey)).toEqual([A]);
    expect(r1.upserts[0].order).toBe(0);
    // a not-yet-synced local copy of a remote entry also upserts (→ marked synced).
    const r2 = reconcile([fe({ pubkey: A, syncState: 'pending-publish', order: 0, petname: 'New' })], remote);
    expect(r2.upserts.map((u) => u.pubkey)).toEqual([A]);
  });
});
