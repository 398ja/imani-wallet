/**
 * NostrFollowSource (spec 044, US4 / T031) — the relay side of follow sync.
 *
 * Implements the coordinator's `RemoteFollowSource` over NIP-02 kind-3, using
 * the validated parse/build helpers in `followSync.ts`:
 *   - pull():    fetch self-authored kind-3 events, pick the latest VALID one
 *                (author + optional signature checked), preserving relay hints
 *                + petnames.
 *   - publish(): build a single metadata-preserving kind-3 (empty content,
 *                order-sorted p-tags), sign it, publish to the configured
 *                private relays.
 *
 * NIP-02: https://github.com/nostr-protocol/nips/blob/master/02.md (pinned).
 */
import type { NostrEvent, NostrFilter } from './NostrLookupAdapter.js';
import type { FollowEntry } from '../types/follow.js';
import type { RemoteFollowSource } from '../core/FollowSyncCoordinator.js';
import {
  KIND_CONTACTS,
  pickLatestValid,
  buildContactListTags,
  type RemoteFollowList,
  type VerifyEventFn,
} from '../core/followSync.js';
import { isValidPubkey, normalizePubkey } from '../utils/validate.js';

/** Unsigned event handed to the signer. */
export interface UnsignedNostrEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface NostrFollowSourceConfig {
  /** The logged-in user's pubkey (the only valid author of our contact list). */
  selfPubkey: string;
  /** Query relays/cache for events matching a filter. */
  query: (filter: NostrFilter) => Promise<NostrEvent[]>;
  /** Sign an unsigned event with the user's key. */
  sign: (event: UnsignedNostrEvent) => Promise<NostrEvent>;
  /** Publish a signed event to the relays. */
  publishEvent: (event: NostrEvent) => Promise<void>;
  /** Optional signature verifier (host supplies nostr-tools verifyEvent). */
  verify?: VerifyEventFn;
  /** Private relays the list lives on (must be wss://). */
  relays?: string[];
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number;
}

export class NostrFollowSource implements RemoteFollowSource {
  private readonly selfPubkey: string;
  private readonly query: NostrFollowSourceConfig['query'];
  private readonly sign: NostrFollowSourceConfig['sign'];
  private readonly publishEvent: NostrFollowSourceConfig['publishEvent'];
  private readonly verify?: VerifyEventFn;
  private readonly now: () => number;

  constructor(config: NostrFollowSourceConfig) {
    if (!isValidPubkey(config.selfPubkey)) {
      throw new Error('NostrFollowSource requires a valid selfPubkey');
    }
    // Private relays only — reject non-wss endpoints (Constitution I).
    for (const relay of config.relays ?? []) {
      if (typeof relay !== 'string' || !relay.startsWith('wss://')) {
        throw new Error(`Refusing non-wss relay for follow sync: ${relay}`);
      }
    }
    this.selfPubkey = normalizePubkey(config.selfPubkey);
    this.query = config.query;
    this.sign = config.sign;
    this.publishEvent = config.publishEvent;
    this.verify = config.verify;
    this.now = config.now ?? (() => Date.now());
  }

  async pull(): Promise<RemoteFollowList | null> {
    const filter: NostrFilter = {
      kinds: [KIND_CONTACTS],
      authors: [this.selfPubkey],
      limit: 5,
    };
    const events = await this.query(filter);
    return pickLatestValid(events ?? [], this.selfPubkey, this.verify);
  }

  async publish(
    entries: ReadonlyArray<Pick<FollowEntry, 'pubkey' | 'order' | 'relayHint' | 'petname' | 'createdAt'>>
  ): Promise<void> {
    const unsigned: UnsignedNostrEvent = {
      kind: KIND_CONTACTS,
      created_at: Math.floor(this.now() / 1000),
      tags: buildContactListTags(entries),
      content: '',
    };
    const signed = await this.sign(unsigned);
    await this.publishEvent(signed);
  }
}

export function createNostrFollowSource(config: NostrFollowSourceConfig): NostrFollowSource {
  return new NostrFollowSource(config);
}
