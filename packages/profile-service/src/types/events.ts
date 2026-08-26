import type { Profile } from './profile.js';
import type { ProfileFilter } from './filters.js';

/**
 * Event types emitted by ProfileService
 */
export type ProfileEventType =
  | 'followAdded'
  | 'followRemoved'
  | 'followSyncError'
  | 'searchExecuted'
  | 'profileViewed'
  | 'cacheHit'
  | 'cacheMiss';

/**
 * Base event interface
 */
export interface ProfileEventBase {
  type: ProfileEventType;
  timestamp: number;
}

/**
 * Follow added event
 */
export interface FollowAddedEvent extends ProfileEventBase {
  type: 'followAdded';
  pubkey: string;
  labels?: string[];
}

/**
 * Follow removed event
 */
export interface FollowRemovedEvent extends ProfileEventBase {
  type: 'followRemoved';
  pubkey: string;
}

/**
 * Follow sync error event
 */
export interface FollowSyncErrorEvent extends ProfileEventBase {
  type: 'followSyncError';
  error: string;
  retryable: boolean;
}

/**
 * Search executed event
 */
export interface SearchExecutedEvent extends ProfileEventBase {
  type: 'searchExecuted';
  filter: ProfileFilter;
  resultCount: number;
  durationMs: number;
}

/**
 * Profile viewed event
 */
export interface ProfileViewedEvent extends ProfileEventBase {
  type: 'profileViewed';
  pubkey: string;
  profile?: Profile;
}

/**
 * Cache hit event
 */
export interface CacheHitEvent extends ProfileEventBase {
  type: 'cacheHit';
  key: string;
  cacheType: 'memory' | 'indexeddb';
}

/**
 * Cache miss event
 */
export interface CacheMissEvent extends ProfileEventBase {
  type: 'cacheMiss';
  key: string;
}

/**
 * Union type for all profile events
 */
export type ProfileEvent =
  | FollowAddedEvent
  | FollowRemovedEvent
  | FollowSyncErrorEvent
  | SearchExecutedEvent
  | ProfileViewedEvent
  | CacheHitEvent
  | CacheMissEvent;

/**
 * Event listener function type
 */
export type ProfileEventListener = (event: ProfileEvent) => void;

/**
 * Event emitter interface
 */
export interface ProfileEventEmitter {
  on(listener: ProfileEventListener): () => void;
  emit(event: ProfileEvent): void;
}
