/**
 * RelaySync - Synchronizes transactions with Nostr relays
 *
 * Provides push (local → relay) and pull (relay → local) sync functionality
 * for NIP-60 transaction history events.
 */

import type { TransactionInput } from '../types';
import type { TransactionStore } from '../store/TransactionStore';
import type {
  RelaySyncConfig,
  SyncDirection,
  SyncResult,
  SyncStatus,
  SyncError as SyncErrorType,
  NostrEvent,
} from './types';
import { NIP60_HISTORY_KIND, historyContentToTransaction } from './types';
import { EventBuilder } from './EventBuilder';
import { TypedEventEmitter } from '../utils/eventEmitter';

/**
 * Relay connection interface
 */
export interface RelayConnection {
  url: string;
  publish(event: NostrEvent): Promise<void>;
  subscribe(
    filters: Array<Record<string, unknown>>,
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void
  ): () => void;
  close(): void;
}

/**
 * Relay pool interface for managing multiple relay connections
 */
export interface RelayPool {
  connect(): Promise<void>;
  disconnect(): void;
  publish(event: NostrEvent): Promise<string[]>;
  subscribe(
    filters: Array<Record<string, unknown>>,
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void
  ): () => void;
  getConnectedRelays(): string[];
}

/**
 * Simple relay pool implementation
 */
export class SimpleRelayPool implements RelayPool {
  private relayUrls: string[];
  private sockets: Map<string, WebSocket> = new Map();
  private subscriptionCounter = 0;

  constructor(relayUrls: string[]) {
    this.relayUrls = relayUrls;
  }

  async connect(): Promise<void> {
    const promises = this.relayUrls.map((url) => this.connectToRelay(url));
    await Promise.allSettled(promises);
  }

  private connectToRelay(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(url);

        ws.onopen = () => {
          this.sockets.set(url, ws);
          resolve();
        };

        ws.onerror = (error) => {
          console.error(`Failed to connect to ${url}:`, error);
          reject(error);
        };

        ws.onclose = () => {
          this.sockets.delete(url);
        };

        // Timeout after 10 seconds
        setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            ws.close();
            reject(new Error(`Connection timeout for ${url}`));
          }
        }, 10000);
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    for (const ws of this.sockets.values()) {
      ws.close();
    }
    this.sockets.clear();
  }

  async publish(event: NostrEvent): Promise<string[]> {
    const successfulRelays: string[] = [];
    const message = JSON.stringify(['EVENT', event]);

    for (const [url, ws] of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
          successfulRelays.push(url);
        } catch (error) {
          console.error(`Failed to publish to ${url}:`, error);
        }
      }
    }

    return successfulRelays;
  }

  subscribe(
    filters: Array<Record<string, unknown>>,
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void
  ): () => void {
    const subId = `sub_${++this.subscriptionCounter}`;
    const message = JSON.stringify(['REQ', subId, ...filters]);
    const eoseReceived = new Set<string>();

    const messageHandlers = new Map<string, (e: MessageEvent) => void>();

    for (const [url, ws] of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        const handler = (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            if (Array.isArray(data)) {
              if (data[0] === 'EVENT' && data[1] === subId) {
                onEvent(data[2] as NostrEvent);
              } else if (data[0] === 'EOSE' && data[1] === subId) {
                eoseReceived.add(url);
                if (onEose && eoseReceived.size === this.sockets.size) {
                  onEose();
                }
              }
            }
          } catch {
            // Ignore parse errors
          }
        };

        ws.addEventListener('message', handler);
        messageHandlers.set(url, handler);
        ws.send(message);
      }
    }

    // Return unsubscribe function
    return () => {
      const closeMessage = JSON.stringify(['CLOSE', subId]);
      for (const [url, ws] of this.sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(closeMessage);
          const handler = messageHandlers.get(url);
          if (handler) {
            ws.removeEventListener('message', handler);
          }
        }
      }
    };
  }

  getConnectedRelays(): string[] {
    return Array.from(this.sockets.keys());
  }
}

/**
 * RelaySync class for transaction synchronization
 */
export class RelaySync {
  private store: TransactionStore;
  private config: Required<Omit<RelaySyncConfig, 'cryptoProvider'>> & { cryptoProvider?: RelaySyncConfig['cryptoProvider'] };
  private eventBuilder: EventBuilder;
  private relayPool: RelayPool;
  private events: TypedEventEmitter;
  private status: SyncStatus;
  private autoSyncTimer?: ReturnType<typeof setInterval>;

  constructor(store: TransactionStore, config: RelaySyncConfig, relayPool?: RelayPool) {
    this.store = store;
    this.config = {
      pubkey: config.pubkey,
      signer: config.signer,
      relayUrls: config.relayUrls,
      walletDTag: config.walletDTag ?? 'default',
      encryption: config.encryption ?? true,
      cryptoProvider: config.cryptoProvider,
      batchSize: config.batchSize ?? 50,
      autoSyncInterval: config.autoSyncInterval ?? 0,
    };

    this.eventBuilder = new EventBuilder({
      pubkey: this.config.pubkey,
      signer: this.config.signer,
      walletDTag: this.config.walletDTag,
      encryption: this.config.encryption,
      cryptoProvider: this.config.cryptoProvider,
    });

    this.relayPool = relayPool ?? new SimpleRelayPool(this.config.relayUrls);
    this.events = new TypedEventEmitter();

    this.status = {
      inProgress: false,
      pendingCount: 0,
      synced: false,
    };
  }

  /**
   * Initialize the relay sync (connect to relays)
   */
  async init(): Promise<void> {
    await this.relayPool.connect();
    await this.updatePendingCount();

    // Start auto-sync if configured
    if (this.config.autoSyncInterval > 0) {
      this.startAutoSync();
    }
  }

  /**
   * Close relay connections
   */
  close(): void {
    this.stopAutoSync();
    this.relayPool.disconnect();
  }

  /**
   * Push unsynced transactions to relays
   */
  async push(): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: SyncErrorType[] = [];
    let pushed = 0;

    this.status.inProgress = true;
    this.status.currentDirection = 'push';
    this.events.emit('sync:started', { direction: 'push', timestamp: startTime });

    try {
      // Get unsynced transactions
      const unsynced = await this.store.getUnsynced();

      if (unsynced.length === 0) {
        return this.createResult('push', 0, 0, errors, startTime);
      }

      // Process in batches
      for (let i = 0; i < unsynced.length; i += this.config.batchSize) {
        const batch = unsynced.slice(i, i + this.config.batchSize);

        for (const tx of batch) {
          try {
            const event = await this.eventBuilder.buildHistoryEvent(tx);
            const relays = await this.relayPool.publish(event);

            if (relays.length > 0) {
              // Mark as synced
              await this.store.markSynced([tx.id], [event.id]);
              pushed++;

              this.events.emit('sync:progress', {
                direction: 'push',
                processed: pushed,
                total: unsynced.length,
                percentage: Math.round((pushed / unsynced.length) * 100),
              });
            } else {
              errors.push({
                transactionId: tx.id,
                message: 'No relays accepted the event',
                code: 'RELAY_REJECT',
                retryable: true,
              });
            }
          } catch (error) {
            errors.push({
              transactionId: tx.id,
              message: error instanceof Error ? error.message : 'Unknown error',
              code: 'PUBLISH_ERROR',
              retryable: true,
            });
          }
        }
      }

      this.status.lastPush = Math.floor(Date.now() / 1000);
      await this.updatePendingCount();

      return this.createResult('push', pushed, 0, errors, startTime);
    } finally {
      this.status.inProgress = false;
      this.status.currentDirection = undefined;
    }
  }

  /**
   * Pull transactions from relays
   */
  async pull(): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: SyncErrorType[] = [];
    let pulled = 0;

    this.status.inProgress = true;
    this.status.currentDirection = 'pull';
    this.events.emit('sync:started', { direction: 'pull', timestamp: startTime });

    try {
      // Get the last sync timestamp
      const lastPull = (await this.store.getSyncMeta('lastPull')) as number | undefined;
      const since = lastPull ?? 0;

      // Fetch events from relays
      const events = await this.fetchEvents(since);

      for (const event of events) {
        try {
          // Check if we already have this event
          const existing = await this.store.getByEventId(event.id);
          if (existing) {
            continue;
          }

          // Parse the event content
          const content = await this.eventBuilder.parseHistoryEvent(event);
          if (!content) {
            errors.push({
              eventId: event.id,
              message: 'Failed to parse event content',
              code: 'PARSE_ERROR',
              retryable: false,
            });
            continue;
          }

          // Convert to transaction
          const txData = historyContentToTransaction(
            content,
            event.id,
            event.created_at,
            this.eventBuilder.getWalletDTagFromEvent(event) ?? undefined
          );

          // Generate a new ID and record
          const input: TransactionInput = {
            type: txData.type!,
            direction: txData.direction!,
            tokenAmount: txData.tokenAmount!,
            faceValue: txData.faceValue!,
            faceUnit: txData.faceUnit!,
            faceDecimals: txData.faceDecimals,
            voucherId: txData.voucherId,
            mintUrl: txData.mintUrl,
            counterparty: txData.counterparty,
            counterpartyName: txData.counterpartyName,
            issuerId: txData.issuerId,
            issuerName: txData.issuerName,
            memo: txData.memo,
            timestamp: txData.timestamp,
            walletId: txData.walletId,
          };

          const tx = await this.store.record(input);

          // Mark as synced immediately since it came from relay
          await this.store.update(tx.id, {
            synced: true,
            syncedAt: Math.floor(Date.now() / 1000),
            eventId: event.id,
          });

          pulled++;

          this.events.emit('sync:progress', {
            direction: 'pull',
            processed: pulled,
            total: events.length,
            percentage: Math.round((pulled / events.length) * 100),
          });
        } catch (error) {
          errors.push({
            eventId: event.id,
            message: error instanceof Error ? error.message : 'Unknown error',
            code: 'IMPORT_ERROR',
            retryable: false,
          });
        }
      }

      // Update last pull timestamp
      await this.store.setSyncMeta('lastPull', Math.floor(Date.now() / 1000));
      this.status.lastPull = Math.floor(Date.now() / 1000);
      await this.updatePendingCount();

      return this.createResult('pull', 0, pulled, errors, startTime);
    } finally {
      this.status.inProgress = false;
      this.status.currentDirection = undefined;
    }
  }

  /**
   * Full sync (push then pull)
   */
  async full(): Promise<SyncResult> {
    const startTime = Date.now();

    this.events.emit('sync:started', { direction: 'full', timestamp: startTime });

    const pushResult = await this.push();
    const pullResult = await this.pull();

    const result: SyncResult = {
      direction: 'full',
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      errors: [...pushResult.errors, ...pullResult.errors],
      duration: Date.now() - startTime,
      timestamp: Math.floor(Date.now() / 1000),
    };

    this.status.lastSync = result.timestamp;
    await this.store.setSyncMeta('lastSync', result.timestamp);

    this.events.emit('sync:completed', {
      direction: 'full',
      pushed: result.pushed,
      pulled: result.pulled,
      duration: result.duration,
      timestamp: result.timestamp,
    });

    return result;
  }

  /**
   * Get current sync status
   */
  getStatus(): SyncStatus {
    return { ...this.status };
  }

  /**
   * Subscribe to sync events
   */
  on<T extends 'sync:started' | 'sync:progress' | 'sync:completed' | 'sync:error'>(
    event: T,
    handler: (payload: any) => void
  ): () => void {
    return this.events.on(event as any, handler);
  }

  /**
   * Set wallet d-tag
   */
  setWalletDTag(dTag: string): void {
    this.config.walletDTag = dTag;
    this.eventBuilder.setWalletDTag(dTag);
  }

  // ==================== Private Methods ====================

  /**
   * Fetch events from relays
   */
  private async fetchEvents(since: number): Promise<NostrEvent[]> {
    // Use API if available
    const api = (globalThis as any).nostrApi;
    if (api && typeof api.queryEvents === 'function') {
      try {
        const filter = {
          kinds: [NIP60_HISTORY_KIND],
          authors: [this.config.pubkey],
          since,
        };
        const events = await api.queryEvents(filter);
        return (events || []).filter((e: any) => this.eventBuilder.isValidHistoryEvent(e));
      } catch (err) {
        console.warn('[RelaySync] API query failed, falling back to relay:', err);
      }
    }

    return new Promise((resolve) => {
      const events: NostrEvent[] = [];

      const filters = [
        {
          kinds: [NIP60_HISTORY_KIND],
          authors: [this.config.pubkey],
          since,
        },
      ];

      const unsub = this.relayPool.subscribe(
        filters,
        (event) => {
          if (this.eventBuilder.isValidHistoryEvent(event)) {
            events.push(event);
          }
        },
        () => {
          unsub();
          resolve(events);
        }
      );

      // Timeout after 30 seconds
      setTimeout(() => {
        unsub();
        resolve(events);
      }, 30000);
    });
  }

  /**
   * Update pending count in status
   */
  private async updatePendingCount(): Promise<void> {
    const unsynced = await this.store.getUnsynced();
    this.status.pendingCount = unsynced.length;
    this.status.synced = unsynced.length === 0;
  }

  /**
   * Create sync result
   */
  private createResult(
    direction: SyncDirection,
    pushed: number,
    pulled: number,
    errors: SyncErrorType[],
    startTime: number
  ): SyncResult {
    const result: SyncResult = {
      direction,
      pushed,
      pulled,
      errors,
      duration: Date.now() - startTime,
      timestamp: Math.floor(Date.now() / 1000),
    };

    if (errors.length > 0) {
      this.status.lastError = errors[0].message;
      this.events.emit('sync:error', {
        direction,
        error: new Error(errors[0].message),
        timestamp: result.timestamp,
      });
    }

    this.events.emit('sync:completed', {
      direction,
      pushed,
      pulled,
      duration: result.duration,
      timestamp: result.timestamp,
    });

    return result;
  }

  /**
   * Start auto-sync interval
   */
  private startAutoSync(): void {
    if (this.autoSyncTimer) {
      return;
    }

    this.autoSyncTimer = setInterval(async () => {
      if (!this.status.inProgress) {
        try {
          await this.full();
        } catch (error) {
          console.error('Auto-sync failed:', error);
        }
      }
    }, this.config.autoSyncInterval);
  }

  /**
   * Stop auto-sync interval
   */
  private stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = undefined;
    }
  }
}

/**
 * Create a relay sync instance
 */
export function createRelaySync(
  store: TransactionStore,
  config: RelaySyncConfig,
  relayPool?: RelayPool
): RelaySync {
  return new RelaySync(store, config, relayPool);
}
