import { RedemptionRefusedError } from '../errors';
/**
 * DmPollService - Main service for NIP-17 DM polling and token redemption
 */

import { TypedEventEmitter } from './EventEmitter';
import { ProcessedEventTracker } from './ProcessedEventTracker';
import { FailedEventTracker } from './FailedEventTracker';
import type {
  DmPollConfig,
  ResolvedDmPollConfig,
  DmPollEvents,
  GiftWrapEvent,
  TokenDm,
  Voucher,
  SubscriptionHandle,
  DmPollStatus,
  ProcessUnclaimedResult,
  ReplayResult,
  FailedEvent,
} from '../types';
import { DEFAULT_CONFIG } from '../types/config';

/**
 * DM Polling Service
 *
 * Receives Cashu tokens via Nostr NIP-17 encrypted DMs with automatic redemption.
 * All reads go through nostrdb - never connects directly to relays.
 */
export class DmPollService extends TypedEventEmitter<DmPollEvents> {
  private config: ResolvedDmPollConfig;
  private eventTracker: ProcessedEventTracker;
  private failedTracker: FailedEventTracker;
  private inFlightEvents: Set<string> = new Set();
  private inFlightFingerprints: Set<string> = new Set();
  private subscription: SubscriptionHandle | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: DmPollConfig) {
    super();
    this.config = this.resolveConfig(config);
    this.eventTracker = new ProcessedEventTracker({
      maxEvents: this.config.maxProcessedEvents,
      storageKey: this.config.storageKey,
      storageAdapter: this.config.storageAdapter,
    });
    this.failedTracker = new FailedEventTracker({
      storageAdapter: this.config.storageAdapter,
      retryCooldownMs: this.config.retryCooldownMs ?? 3600000,
    });
  }

  /**
   * Resolve config with defaults
   */
  private resolveConfig(config: DmPollConfig): ResolvedDmPollConfig {
    return {
      ...DEFAULT_CONFIG,
      ...config,
      storageAdapter: config.storageAdapter ?? null,
      redemptionAdapter: config.redemptionAdapter ?? null,
      uiAdapter: config.uiAdapter ?? null,
      legacyApiAdapter: config.legacyApiAdapter ?? null,
      nip60Wallet: config.nip60Wallet ?? null,
    };
  }

  /**
   * Start the DM polling service
   */
  async start(): Promise<void> {
    if (this.running) {
      console.log('[DmPollService] Already running');
      return;
    }

    console.log('[DmPollService] Starting...');
    this.running = true;

    // Load processed events from storage
    await this.eventTracker.load();

    // Load failed events from storage
    await this.failedTracker.load();

    // Fetch recent DMs if configured
    if (this.config.fetchRecentOnStart) {
      await this.fetchRecentDms();
    }

    // Start subscription based on mode
    this.startSubscription();
  }

  /**
   * Stop the DM polling service
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    console.log('[DmPollService] Stopping...');
    this.running = false;

    // Stop subscription
    if (this.subscription) {
      this.subscription.stop();
      this.subscription = null;
    }

    // Stop polling
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.emit('subscription:state', {
      state: 'disconnected',
      mode: this.config.subscriptionMode,
    });
  }

  /**
   * Check if service is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Update recipient keys
   */
  setRecipientKeys(pubkey: string, privkey: string): void {
    this.config.recipientPubkey = pubkey;
    this.config.recipientPrivkey = privkey;
  }

  /**
   * Set NIP-60 wallet adapter
   */
  setNip60Wallet(wallet: DmPollConfig['nip60Wallet']): void {
    this.config.nip60Wallet = wallet ?? null;
  }

  /**
   * Fetch recent DMs from nostrdb
   */
  async fetchRecentDms(): Promise<TokenDm[]> {
    const tokenDms: TokenDm[] = [];
    const since = Math.floor(Date.now() / 1000) - this.config.recentDmsSince;

    try {
      console.log('[DmPollService] Fetching recent DMs since:', new Date(since * 1000));

      const events = await this.config.nostrdbAdapter.queryEvents({
        kinds: [1059],
        pTags: [this.config.recipientPubkey],
        since,
        limit: 50,
      });

      console.log(`[DmPollService] Fetched ${events.length} gift wrap events`);

      for (const event of events) {
        const tokenDm = await this.processGiftWrap(event);
        if (tokenDm) {
          tokenDms.push(tokenDm);
        }
      }
    } catch (error) {
      console.error('[DmPollService] Failed to fetch recent DMs:', error);
    }

    return tokenDms;
  }

  /**
   * Process a gift wrap event
   */
  async processGiftWrap(event: GiftWrapEvent): Promise<TokenDm | null> {
    // Check if already processed
    if (this.eventTracker.has(event.id)) {
      console.log('[DmPollService] Event already processed:', event.id.substring(0, 8));
      return null;
    }

    // Prevent concurrent processing of the same event (SSE can deliver duplicates
    // before the first call reaches eventTracker.add, causing double-redemption)
    if (this.inFlightEvents.has(event.id)) {
      console.log('[DmPollService] Event already in-flight:', event.id.substring(0, 8));
      return null;
    }
    this.inFlightEvents.add(event.id);
    let fingerprint: string | null = null;

    try {
      // Unwrap the gift wrap (client-side decryption)
      const unwrapped = await this.config.cryptoAdapter.unwrapNip17Dm(
        event,
        this.config.recipientPrivkey
      );

      if (!unwrapped) {
        console.log('[DmPollService] Failed to unwrap gift wrap:', event.id.substring(0, 8));
        await this.failedTracker.track(event.id, event, 'Failed to unwrap gift wrap');
        return null;
      }

      // Extract token from content
      const token = this.config.cryptoAdapter.extractToken(unwrapped.content);
      if (!token) {
        console.log('[DmPollService] No token found in DM:', event.id.substring(0, 8));
        await this.eventTracker.add(event.id);
        return null;
      }

      // Check for duplicate token by fingerprint. The adapter may be async
      // (e.g. SHA-256 via WebCrypto in shared/dmPollIntegration.js); without
      // the await, `fingerprint` would be a Promise and dedup would silently
      // miss every event because Promise identity never matches a stored string.
      fingerprint = await this.config.cryptoAdapter.getTokenFingerprint(token);
      if (this.config.storageAdapter) {
        const alreadyReceived = await this.config.storageAdapter.hasTokenBeenReceived(fingerprint);
        if (alreadyReceived) {
          console.log('[DmPollService] Token already received:', fingerprint.substring(0, 8));
          await this.eventTracker.add(event.id);
          return null;
        }
      }

      // Prevent concurrent redemption of the same token across different events
      // (e.g., same token re-wrapped in a new DM, or SSE re-delivery)
      if (this.inFlightFingerprints.has(fingerprint)) {
        console.log('[DmPollService] Token fingerprint already in-flight:', fingerprint.substring(0, 8));
        await this.eventTracker.add(event.id);
        return null;
      }
      this.inFlightFingerprints.add(fingerprint);

      // Parse token metadata
      const metadata = this.config.cryptoAdapter.parseTokenTransferMessage(unwrapped.content) ?? {};

      const tokenDm: TokenDm = {
        eventId: event.id,
        senderPubkey: unwrapped.senderPubkey,
        token,
        metadata,
        createdAt: unwrapped.createdAt,
      };

      // Emit token received event
      this.emit('token:received', {
        eventId: event.id,
        token,
        tokenDm,
      });

      // Auto-redeem if enabled
      if (this.config.enableAutoRedemption && this.config.redemptionAdapter) {
        await this.redeemToken(tokenDm);
      }

      // Mark as processed
      await this.eventTracker.add(event.id);

      return tokenDm;
    } catch (error) {
      console.error('[DmPollService] Error processing gift wrap:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.failedTracker.track(event.id, event, errorMessage);
      return null;
    } finally {
      this.inFlightEvents.delete(event.id);
      if (fingerprint) {
        this.inFlightFingerprints.delete(fingerprint);
      }
    }
  }

  /**
   * Redeem a token
   */
  private async redeemToken(tokenDm: TokenDm): Promise<Voucher | null> {
    if (!this.config.redemptionAdapter) {
      return null;
    }

    try {
      const voucher = await this.config.redemptionAdapter.redeem(tokenDm.token, {
        metadata: tokenDm.metadata,
        nip60Wallet: this.config.nip60Wallet ?? undefined,
        senderPubkey: tokenDm.senderPubkey,
      });

      // Mark token as received
      if (this.config.storageAdapter) {
        const fingerprint = await this.config.cryptoAdapter.getTokenFingerprint(tokenDm.token);
        await this.config.storageAdapter.markTokenAsReceived(fingerprint);
        await this.config.storageAdapter.saveVoucher(voucher);
      }

      // Get sender profile for notification
      let senderProfile;
      if (this.config.enableUiNotifications) {
        senderProfile = await this.config.nostrdbAdapter.getProfile(tokenDm.senderPubkey);
      }

      // Emit success event. Spec 012-multi-voucher-send T036: surface the
      // bundle metadata (when present in the parsed TokenMetadata) and the
      // verified senderPubkey so the bundle aggregator can ingest correctly.
      const md = tokenDm.metadata ?? {};
      const bundleEnvelope = md.bundleId
        ? {
            bundleId: md.bundleId,
            bundleTotal: md.bundleTotal ?? 0,
            bundlePartIndex: md.bundlePartIndex ?? 0,
            bundlePartCount: md.bundlePartCount ?? 1,
            bundlePartId: md.bundlePartId ?? `${md.bundleId}:${md.bundlePartIndex ?? 0}`,
            bundleAttempt: md.bundleAttempt ?? 0,
          }
        : undefined;
      this.emit('redemption:success', {
        voucher,
        senderProfile: senderProfile ?? undefined,
        eventId: tokenDm.eventId,
        senderPubkey: tokenDm.senderPubkey,
        bundle: bundleEnvelope,
      });

      // Show UI notification
      if (this.config.enableUiNotifications && this.config.uiAdapter) {
        this.config.uiAdapter.showReceivedNotification(voucher, senderProfile ?? undefined);
      }

      return voucher;
    } catch (error) {
      // Detect "already redeemed" errors — treat as idempotent success, not failure.
      // This handles cases where SSE re-delivers events, localStorage lost dedup state
      // (e.g., alpha browsers with unreliable storage), or page reloaded mid-redemption.
      // Terminal, and NOT a success: the recipient refused this redemption on
      // policy grounds before any swap happened. Mark it received so the poller
      // stops re-offering it — retrying cannot change the answer — but emit no
      // redemption:success, because no money arrived. An unclassified throw
      // would be treated as transient and retried forever.
      if (error instanceof RedemptionRefusedError) {
        console.warn(
          '[DmPollService] Redemption refused:',
          error.message,
          'voucher',
          error.voucherId,
        );
        if (this.config.storageAdapter) {
          const fingerprint = await this.config.cryptoAdapter.getTokenFingerprint(tokenDm.token);
          await this.config.storageAdapter.markTokenAsReceived(fingerprint).catch(() => {});
        }
        this.emit('redemption:refused', {
          eventId: tokenDm.eventId,
          senderPubkey: tokenDm.senderPubkey,
          voucherId: error.voucherId,
          alreadyRedeemed: error.alreadyRedeemed,
          signedFaceValue: error.signedFaceValue,
        });
        return null;
      }

      if (this.isAlreadyRedeemedError(error)) {
        console.log('[DmPollService] Token already redeemed (idempotent):', tokenDm.eventId.substring(0, 8));

        // Mark token as received to prevent future retries
        if (this.config.storageAdapter) {
          const fingerprint = await this.config.cryptoAdapter.getTokenFingerprint(tokenDm.token);
          await this.config.storageAdapter.markTokenAsReceived(fingerprint).catch(() => {});
        }

        // Emit a synthetic redemption:success so downstream aggregators (e.g. the
        // BundleReceiptStore for spec 012 multi-voucher receives) get told about
        // this part. Otherwise a bundle whose part 0 hits this branch would only
        // surface partial value to the receiver — exactly the "received 0.09 of
        // 1.09" bug. The voucher is reconstructed from the parsed metadata; the
        // funds themselves were already credited by the earlier successful call,
        // so no re-save to storage.
        const md = tokenDm.metadata ?? {};
        if (md.bundleId) {
          const idempotentVoucher: Voucher = {
            voucher_id: md.voucherId ?? `dup-${tokenDm.eventId.substring(0, 16)}`,
            token: tokenDm.token,
            face_value: md.faceValue ?? 0,
            face_unit: md.faceUnit ?? 'SAT',
            face_decimals: md.faceDecimals ?? 0,
            token_amount: md.tokenAmount ?? 0,
            token_unit: 'sat',
            backing_strategy: md.backingStrategy ?? 'MINIMAL',
            status: 'spent',
            created_at: new Date(tokenDm.createdAt * 1000).toISOString(),
            sender_pubkey: tokenDm.senderPubkey,
            memo: md.memo,
            issuer_id: md.issuerId,
          };
          const bundleEnvelope = {
            bundleId: md.bundleId,
            bundleTotal: md.bundleTotal ?? 0,
            bundlePartIndex: md.bundlePartIndex ?? 0,
            bundlePartCount: md.bundlePartCount ?? 1,
            bundlePartId: md.bundlePartId ?? `${md.bundleId}:${md.bundlePartIndex ?? 0}`,
            bundleAttempt: md.bundleAttempt ?? 0,
          };
          this.emit('redemption:success', {
            voucher: idempotentVoucher,
            senderProfile: undefined,
            eventId: tokenDm.eventId,
            senderPubkey: tokenDm.senderPubkey,
            bundle: bundleEnvelope,
          });
        }

        return null;
      }

      console.error('[DmPollService] Redemption failed:', error);

      this.emit('redemption:error', {
        message: error instanceof Error ? error.message : 'Unknown error',
        error: error instanceof Error ? error : new Error(String(error)),
        token: tokenDm.token,
        eventId: tokenDm.eventId,
      });

      if (this.config.uiAdapter) {
        this.config.uiAdapter.showErrorNotification(
          `Failed to redeem token: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }

      // Rethrow so the outer processGiftWrap catch records this in failedTracker
      // and skips the eventTracker.add call. Without this rethrow, a transient
      // mint failure marked the event as permanently processed, blocking every
      // future retry — even processUnclaimedTokens cannot recover from that
      // because processGiftWrap short-circuits on eventTracker.has().
      throw error;
    }
  }

  /**
   * Check if an error indicates the token was already redeemed.
   * These are idempotent — the token was successfully redeemed, just not by this call.
   */
  private isAlreadyRedeemedError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return (
      message.includes('already redeemed') ||
      message.includes('already been redeemed') ||
      message.includes('proof already used') ||
      message.includes('already spent') ||
      message.includes('token already')
    );
  }

  /**
   * Start the appropriate subscription based on mode
   */
  private startSubscription(): void {
    const mode = this.config.subscriptionMode;

    this.emit('subscription:state', {
      state: 'connecting',
      mode,
    });

    switch (mode) {
      case 'nostrdb-sse':
        this.startNostrdbSseSubscription();
        break;

      case 'nostrdb-polling':
        this.startNostrdbPolling();
        break;

      case 'legacy-api':
        this.startLegacyApiPolling();
        break;

      case 'auto':
      default:
        // Try SSE first, fallback to polling
        this.startNostrdbSseSubscription();
        break;
    }
  }

  /**
   * Start nostrdb SSE subscription
   */
  private startNostrdbSseSubscription(): void {
    try {
      this.subscription = this.config.nostrdbAdapter.subscribeEvents(
        {
          kinds: [1059],
          pTags: [this.config.recipientPubkey],
        },
        (event) => {
          this.processGiftWrap(event).catch(console.error);
        },
        (error) => {
          console.error('[DmPollService] SSE subscription error:', error);

          this.emit('subscription:state', {
            state: 'error',
            mode: 'nostrdb-sse',
            error: error.message,
          });

          // Fallback to polling in auto mode
          if (this.config.subscriptionMode === 'auto') {
            console.log('[DmPollService] Falling back to polling mode');
            this.startNostrdbPolling();
          }
        }
      );

      this.emit('subscription:state', {
        state: 'connected',
        mode: 'nostrdb-sse',
      });
    } catch (error) {
      console.error('[DmPollService] Failed to start SSE subscription:', error);

      // Fallback to polling in auto mode
      if (this.config.subscriptionMode === 'auto') {
        this.startNostrdbPolling();
      }
    }
  }

  /**
   * Start nostrdb polling
   */
  private startNostrdbPolling(): void {
    console.log('[DmPollService] Starting polling mode with interval:', this.config.pollIntervalMs);

    this.pollInterval = setInterval(() => {
      this.fetchRecentDms().catch(console.error);
    }, this.config.pollIntervalMs);

    this.emit('subscription:state', {
      state: 'connected',
      mode: 'nostrdb-polling',
    });
  }

  /**
   * Start legacy API polling
   */
  private startLegacyApiPolling(): void {
    if (!this.config.legacyApiAdapter) {
      console.error('[DmPollService] Legacy API adapter not configured');
      return;
    }

    console.log('[DmPollService] Starting legacy API polling');

    this.pollInterval = setInterval(() => {
      this.pollLegacyApi().catch(console.error);
    }, this.config.pollIntervalMs);

    // Initial poll
    this.pollLegacyApi().catch(console.error);

    this.emit('subscription:state', {
      state: 'connected',
      mode: 'legacy-api',
    });
  }

  /**
   * Poll legacy API for pending DMs
   */
  private async pollLegacyApi(): Promise<void> {
    if (!this.config.legacyApiAdapter) {
      return;
    }

    try {
      const response = await this.config.legacyApiAdapter.listTokenDms({
        status: 'pending',
        limit: 10,
      });

      for (const dm of response.items) {
        if (this.eventTracker.has(dm.eventId)) {
          continue;
        }

        // Claim the DM
        const claimResponse = await this.config.legacyApiAdapter.claimTokenDm(dm.eventId);
        if (!claimResponse.success || !claimResponse.token) {
          continue;
        }

        // Create token DM structure
        const tokenDm: TokenDm = {
          eventId: dm.eventId,
          senderPubkey: dm.senderPubkey,
          token: claimResponse.token,
          metadata: {},
          createdAt: dm.createdAt,
        };

        this.emit('token:received', {
          eventId: dm.eventId,
          token: claimResponse.token,
          tokenDm,
        });

        // Redeem if enabled
        if (this.config.enableAutoRedemption && this.config.redemptionAdapter) {
          await this.redeemToken(tokenDm);
        }

        await this.eventTracker.add(dm.eventId);
      }
    } catch (error) {
      console.error('[DmPollService] Legacy API poll failed:', error);
    }
  }

  // ==================== UNCLAIMED TOKEN METHODS ====================

  /**
   * Get unclaimed tokens by comparing gift wraps against processed events
   *
   * @param sinceDays - Number of days to look back (default: 7)
   * @returns Array of unclaimed gift wrap events
   */
  async getUnclaimedTokens(sinceDays = 7): Promise<GiftWrapEvent[]> {
    const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;

    console.log('[DmPollService] Fetching unclaimed tokens since:', new Date(since * 1000));

    try {
      const events = await this.config.nostrdbAdapter.queryEvents({
        kinds: [1059],
        pTags: [this.config.recipientPubkey],
        since,
        limit: 100,
      });

      console.log(`[DmPollService] Found ${events.length} total gift wrap events`);

      // Filter out processed events (but include failed ones as they're unclaimed)
      const unclaimed = events.filter((e) => !this.eventTracker.has(e.id));

      console.log(`[DmPollService] Unclaimed tokens: ${unclaimed.length}`);
      return unclaimed;
    } catch (error) {
      console.error('[DmPollService] Failed to get unclaimed tokens:', error);
      return [];
    }
  }

  /**
   * Get list of failed events
   *
   * @returns Array of FailedEvent
   */
  getFailedEvents(): FailedEvent[] {
    return this.failedTracker.getAll();
  }

  /**
   * Replay a specific failed event
   *
   * @param eventId - Event ID to replay
   * @returns true if replay succeeded
   */
  async replayEvent(eventId: string): Promise<boolean> {
    const failed = this.failedTracker.get(eventId);
    if (!failed) {
      console.warn('[DmPollService] Event not found in failed events:', eventId);
      return false;
    }

    console.log(`[DmPollService] Replaying failed event: ${eventId.substring(0, 16)}...`);

    try {
      // Remove from failed events before retrying
      await this.failedTracker.remove(eventId);

      // Re-process the event
      const result = await this.processGiftWrap(failed.event);

      if (result) {
        console.log(`[DmPollService] Replay succeeded: ${eventId.substring(0, 16)}...`);
        return true;
      } else {
        // processGiftWrap already tracks failures
        console.log(`[DmPollService] Replay failed: ${eventId.substring(0, 16)}...`);
        return false;
      }
    } catch (error) {
      console.error('[DmPollService] Replay error:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.failedTracker.track(eventId, failed.event, errorMessage);
      return false;
    }
  }

  /**
   * Replay all failed events
   *
   * @returns Result with success and failure counts
   */
  async replayAllFailed(): Promise<ReplayResult> {
    const failedEvents = this.failedTracker.getRetryable();
    console.log(`[DmPollService] Replaying ${failedEvents.length} failed events...`);

    let success = 0;
    let failed = 0;

    for (const failedEvent of failedEvents) {
      const result = await this.replayEvent(failedEvent.eventId);
      if (result) {
        success++;
      } else {
        failed++;
      }

      // Small delay between retries
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log(`[DmPollService] Replay complete. Success: ${success}, Failed: ${failed}`);
    return { success, failed };
  }

  /**
   * Process all unclaimed tokens
   *
   * @param sinceDays - Number of days to look back (default: 7)
   * @returns Result with processed, failed, and skipped counts
   */
  async processUnclaimedTokens(sinceDays = 7): Promise<ProcessUnclaimedResult> {
    console.log('[DmPollService] Processing all unclaimed tokens...');

    const unclaimed = await this.getUnclaimedTokens(sinceDays);
    let processed = 0;
    let failed = 0;
    let skipped = 0;

    for (const event of unclaimed) {
      // Check if it's in the failed list and in cooldown
      if (this.failedTracker.has(event.id) && !this.failedTracker.canRetry(event.id)) {
        console.log(`[DmPollService] Skipping recently failed event: ${event.id.substring(0, 16)}...`);
        skipped++;
        continue;
      }

      try {
        const result = await this.processGiftWrap(event);

        if (result) {
          processed++;
        } else if (this.eventTracker.has(event.id)) {
          // Was processed but no token (regular DM)
          skipped++;
        } else {
          failed++;
        }
      } catch (error) {
        console.error('[DmPollService] Error processing unclaimed token:', error);
        failed++;
      }

      // Small delay between processing
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log(
      `[DmPollService] Unclaimed processing complete. Processed: ${processed}, Failed: ${failed}, Skipped: ${skipped}`
    );
    return { processed, failed, skipped };
  }

  /**
   * Clear all failed events
   */
  async clearFailedEvents(): Promise<void> {
    await this.failedTracker.clear();
  }

  /**
   * Clear all processed events (for debugging)
   */
  async clearProcessedEvents(): Promise<void> {
    await this.eventTracker.clear();
  }

  /**
   * Get service status
   *
   * @returns Status information
   */
  getStatus(): DmPollStatus {
    const failedEvents = this.failedTracker.getAll().map((fe) => ({
      eventId: fe.eventId.substring(0, 16) + '...',
      error: fe.error,
      attempts: fe.attempts,
      lastAttempt: new Date(fe.lastAttempt).toISOString(),
    }));

    return {
      isRunning: this.running,
      subscriptionMode: this.config.subscriptionMode,
      recipientPubkey: this.config.recipientPubkey
        ? this.config.recipientPubkey.substring(0, 16) + '...'
        : '(not set)',
      hasPrivkey: !!this.config.recipientPrivkey,
      processedCount: this.eventTracker.size,
      failedCount: this.failedTracker.size,
      failedEvents,
    };
  }

  /**
   * Log service status to console
   */
  showStatus(): void {
    const status = this.getStatus();

    console.log('=== DmPollService Status ===');
    console.log('Is running:', status.isRunning);
    console.log('Subscription mode:', status.subscriptionMode);
    console.log('Recipient pubkey:', status.recipientPubkey);
    console.log('Has privkey:', status.hasPrivkey);
    console.log('Processed events:', status.processedCount);
    console.log('Failed events:', status.failedCount);

    if (status.failedEvents.length > 0) {
      console.log('\nFailed events:');
      for (const fe of status.failedEvents) {
        console.log(`  - ${fe.eventId} | error: ${fe.error} | attempts: ${fe.attempts}`);
      }
    }

    console.log('============================');
  }
}

/**
 * Factory function to create a DmPollService
 */
export function createDmPollService(config: DmPollConfig): DmPollService {
  return new DmPollService(config);
}
