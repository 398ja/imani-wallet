/**
 * LegacyApiPolling - Backward compatibility with old DM API
 *
 * FALLBACK only - Uses the legacy listTokenDms/claimTokenDm API
 * for environments where nostrdb is not available.
 */

import type { SubscriptionHandle } from '../types/subscription';
import type { LegacyApiAdapter, LegacyDm } from '../adapters/LegacyApiAdapter';

/**
 * Options for LegacyApiPolling
 */
export interface LegacyApiPollingOptions {
  /** Legacy API adapter */
  legacyApiAdapter: LegacyApiAdapter;

  /** Polling interval in ms */
  pollIntervalMs?: number;

  /** Maximum DMs to fetch per poll */
  limit?: number;

  /** Callback when a DM is received */
  onDm: (dm: LegacyDm, token: string) => void;

  /** Callback when error occurs */
  onError: (error: Error) => void;

  /** Set of already processed event IDs (for deduplication) */
  processedEventIds?: Set<string>;
}

/**
 * Legacy API polling for backward compatibility
 */
export class LegacyApiPolling implements SubscriptionHandle {
  readonly id: string;
  private active = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  private readonly options: Required<Omit<LegacyApiPollingOptions, 'processedEventIds'>> & {
    processedEventIds: Set<string>;
  };

  constructor(options: LegacyApiPollingOptions) {
    this.id = `legacy-api-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    this.options = {
      pollIntervalMs: 30000,
      limit: 10,
      processedEventIds: new Set(),
      ...options,
    };
  }

  /**
   * Start polling
   */
  start(): void {
    if (this.active) {
      console.log('[LegacyApiPolling] Already active');
      return;
    }

    this.active = true;
    console.log('[LegacyApiPolling] Starting with interval:', this.options.pollIntervalMs, 'ms');

    // Initial poll
    this.poll().catch(console.error);

    // Set up interval
    this.pollInterval = setInterval(() => {
      this.poll().catch(console.error);
    }, this.options.pollIntervalMs);
  }

  /**
   * Stop polling
   */
  stop(): void {
    this.active = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    console.log('[LegacyApiPolling] Stopped');
  }

  /**
   * Check if polling is active
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Execute a single poll
   */
  private async poll(): Promise<void> {
    if (!this.active || this.polling) return;

    this.polling = true;

    try {
      const response = await this.options.legacyApiAdapter.listTokenDms({
        status: 'pending',
        limit: this.options.limit,
      });

      for (const dm of response.items) {
        if (this.options.processedEventIds.has(dm.eventId)) {
          continue;
        }

        try {
          // Claim the DM
          const claimResponse = await this.options.legacyApiAdapter.claimTokenDm(dm.eventId);

          if (claimResponse.success && claimResponse.token) {
            this.options.processedEventIds.add(dm.eventId);
            this.options.onDm(dm, claimResponse.token);
          } else if (claimResponse.error) {
            console.warn('[LegacyApiPolling] Claim failed:', claimResponse.error);
            // Mark as processed to avoid retry loops
            this.options.processedEventIds.add(dm.eventId);
          }
        } catch (error) {
          console.error('[LegacyApiPolling] Failed to claim DM:', error);
        }
      }
    } catch (error) {
      console.error('[LegacyApiPolling] Poll failed:', error);
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.polling = false;
    }
  }

  /**
   * Trigger an immediate poll
   */
  async pollNow(): Promise<void> {
    await this.poll();
  }
}

/**
 * Create a LegacyApiPolling instance
 */
export function createLegacyApiPolling(
  options: LegacyApiPollingOptions
): LegacyApiPolling {
  const polling = new LegacyApiPolling(options);
  polling.start();
  return polling;
}
