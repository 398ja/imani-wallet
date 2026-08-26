/**
 * FollowSyncCoordinator (spec 044, US4 / T030).
 *
 * Orchestrates convergence between the local follow store and the relay's
 * NIP-02 kind-3 contact list: pull → reconcile (research R2) → apply → publish.
 * The NIP-02 parse/build/validate + merge logic lives in `followSync.ts`; this
 * class is the stateful glue. It is decoupled from IndexedDB and the relay via
 * the `FollowLocalStore` + `RemoteFollowSource` interfaces so it is unit-testable.
 */
import type { FollowEntry } from '../types/follow.js';
import {
  reconcile,
  type RemoteFollowList,
} from './followSync.js';

/** Minimal local-store surface the coordinator needs (LocalFollowAdapter fits). */
export interface FollowLocalStore {
  listEntries(): Promise<FollowEntry[]>;
  add(
    pubkey: string,
    opts?: {
      syncState?: FollowEntry['syncState'];
      order?: number;
      relayHint?: string | null;
      petname?: string | null;
    }
  ): Promise<void>;
  remove(pubkey: string): Promise<void>;
}

/** The relay side: pull the latest valid kind-3, publish a fresh one. */
export interface RemoteFollowSource {
  /** Latest valid remote list, or null when no valid event exists yet. */
  pull(): Promise<RemoteFollowList | null>;
  /** Publish the full follow set as a single kind-3 (one writer). */
  publish(
    entries: ReadonlyArray<Pick<FollowEntry, 'pubkey' | 'order' | 'relayHint' | 'petname' | 'createdAt'>>
  ): Promise<void>;
}

export interface FollowSyncState {
  hydrated: boolean;
  pendingCount: number;
  lastReconcileAt: number | null;
  lastError: string | null;
}

export interface FollowSyncCoordinatorConfig {
  store: FollowLocalStore;
  remote: RemoteFollowSource;
  onChange?: () => void;
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number;
}

export class FollowSyncCoordinator {
  private readonly store: FollowLocalStore;
  private readonly remote: RemoteFollowSource;
  private readonly onChange?: () => void;
  private readonly now: () => number;
  private state: FollowSyncState = {
    hydrated: false,
    pendingCount: 0,
    lastReconcileAt: null,
    lastError: null,
  };
  private inFlight: Promise<FollowSyncState> | null = null;

  constructor(config: FollowSyncCoordinatorConfig) {
    this.store = config.store;
    this.remote = config.remote;
    this.onChange = config.onChange;
    this.now = config.now ?? (() => Date.now());
  }

  getState(): FollowSyncState {
    return { ...this.state };
  }

  /** Run one reconcile pass. Serialized — concurrent calls share the run. */
  async syncNow(): Promise<FollowSyncState> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runReconcile();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runReconcile(): Promise<FollowSyncState> {
    let changed = false;
    try {
      const local = await this.store.listEntries();
      const remote = await this.remote.pull();
      const result = reconcile(local, remote);

      // Apply the remote baseline (synced) + remote-side removals.
      for (const u of result.upserts) {
        await this.store.add(u.pubkey, {
          syncState: 'synced',
          order: u.order,
          relayHint: u.relayHint,
          petname: u.petname,
        });
        changed = true;
      }
      for (const pk of result.removes) {
        await this.store.remove(pk);
        changed = true;
      }

      // Publish our intended set when we have local pending work, then mark
      // those entries synced (exactly one kind-3 writer per flush).
      if (result.shouldPublish) {
        const applied = await this.store.listEntries();
        const toPublish = applied.filter((e) => e.syncState !== 'pending-removal');
        await this.remote.publish(toPublish);
        for (const e of applied) {
          if (e.syncState === 'pending-publish') {
            await this.store.add(e.pubkey, {
              syncState: 'synced',
              order: e.order,
              relayHint: e.relayHint,
              petname: e.petname,
            });
            changed = true;
          }
        }
      }

      const finalEntries = await this.store.listEntries();
      const pendingCount = finalEntries.filter((e) => e.syncState !== 'synced').length;
      this.state = { hydrated: true, pendingCount, lastReconcileAt: this.now(), lastError: null };
    } catch (e) {
      // Non-secret diagnostic category only.
      this.state = { ...this.state, lastError: e instanceof Error ? e.name : 'sync_failed' };
    }
    if (changed) this.onChange?.();
    return this.getState();
  }
}

export function createFollowSyncCoordinator(config: FollowSyncCoordinatorConfig): FollowSyncCoordinator {
  return new FollowSyncCoordinator(config);
}
