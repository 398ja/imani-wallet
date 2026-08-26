import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFollowAdapter } from '../../src/index.js';

/**
 * Spec 044 (T007): the follow entry carries the merchant discriminator + sync
 * state + preserved NIP-02 metadata, defaults are applied, malformed pubkeys are
 * rejected, and the stored record contains ONLY non-secret fields (FR-015).
 */
describe('FollowEntry shape (spec 044)', () => {
  let adapter: MemoryFollowAdapter;
  const pk = 'a'.repeat(64);

  beforeEach(() => {
    adapter = new MemoryFollowAdapter();
  });

  it('a bare local follow gets safe defaults', async () => {
    await adapter.add(pk);
    const entry = await adapter.getEntry(pk);
    expect(entry).not.toBeNull();
    expect(entry!.merchant).toBe('unknown');
    expect(entry!.merchantCheckedAt).toBeNull();
    expect(entry!.syncState).toBe('pending-publish');
    expect(entry!.relayHint).toBeNull();
    expect(entry!.petname).toBeNull();
    expect(typeof entry!.order).toBe('number');
    expect(typeof entry!.addedAt).toBe('number');
  });

  it('round-trips merchant / order / syncState / relayHint / petname from opts', async () => {
    await adapter.add(pk, {
      merchant: 'merchant',
      merchantCheckedAt: 123,
      order: 7,
      syncState: 'synced',
      relayHint: 'wss://relay.staging.398ja.xyz',
      petname: 'Alice',
    });
    const entry = await adapter.getEntry(pk);
    expect(entry!.merchant).toBe('merchant');
    expect(entry!.merchantCheckedAt).toBe(123);
    expect(entry!.order).toBe(7);
    expect(entry!.syncState).toBe('synced');
    expect(entry!.relayHint).toBe('wss://relay.staging.398ja.xyz');
    expect(entry!.petname).toBe('Alice');
  });

  it('the stored record contains ONLY non-secret follow fields (FR-015)', async () => {
    await adapter.add(pk, { petname: 'Bob' });
    const entry = await adapter.getEntry(pk);
    const allowed = new Set([
      'pubkey', 'labels', 'createdAt', 'source',
      'merchant', 'merchantCheckedAt', 'addedAt', 'order',
      'syncState', 'relayHint', 'petname',
      // spec 044 (#2): denormalized kind-0 profile snapshot (non-secret)
      'displayName', 'picture', 'nip05', 'profileUpdatedAt',
    ]);
    for (const key of Object.keys(entry!)) {
      expect(allowed.has(key), `unexpected field "${key}" in stored follow entry`).toBe(true);
    }
    // Defensive: no secret/identity material keys.
    for (const forbidden of ['nsec', 'privateKey', 'private_key', 'seed', 'sig', 'secret']) {
      expect(Object.prototype.hasOwnProperty.call(entry!, forbidden)).toBe(false);
    }
  });

  it('bounds petname length', async () => {
    await adapter.add(pk, { petname: 'x'.repeat(500) });
    const entry = await adapter.getEntry(pk);
    expect(entry!.petname!.length).toBeLessThanOrEqual(80);
  });

  it('rejects malformed pubkeys', async () => {
    await expect(adapter.add('not-a-pubkey')).rejects.toThrow();
    await expect(adapter.add('A'.repeat(63))).rejects.toThrow();
  });
});
