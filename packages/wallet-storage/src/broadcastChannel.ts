/**
 * BroadcastChannel wrapper with feature detection.
 *
 * Service-worker contexts (Chrome) and modern browsers support
 * `BroadcastChannel`; some embedded webviews and certain Safari
 * configurations don't. When absent, we silently no-op the post +
 * subscribe surface so the IDB write still commits (per
 * specs/024-vouchers-tx-idb-migration/research.md §R8) — cross-tab
 * notification just degrades to "next read reconciles".
 */

import type { WalletStorageEvent } from './types';

export interface BroadcastChannelLike {
  post(event: WalletStorageEvent): void;
  subscribe(listener: (event: WalletStorageEvent) => void): () => void;
  close(): void;
}

/**
 * Default channel name. The spec calls for reuse of the existing
 * `walletSnapshotSync` BroadcastChannel namespace; if no such channel
 * exists in shared/walletSnapshotSync.js yet, this is the canonical
 * name and consumers should pass an explicit channel in if they want
 * a different name space.
 */
export const DEFAULT_CHANNEL_NAME = 'walletSnapshotSync';

/** Feature detection — `true` if BroadcastChannel is usable in this realm. */
export function isBroadcastChannelAvailable(): boolean {
  return typeof globalThis !== 'undefined' && typeof globalThis.BroadcastChannel !== 'undefined';
}

/**
 * Construct a BroadcastChannel wrapper. Pass an existing BroadcastChannel
 * instance to share with other code (the bridge does this so all wallet-
 * scoped events flow over one channel). Otherwise we open one on
 * `channelName` (default {@link DEFAULT_CHANNEL_NAME}).
 *
 * When BroadcastChannel is unavailable in this realm, returns a no-op
 * implementation that silently swallows posts + subscriptions.
 */
export function createBroadcastChannel(opts: {
  channel?: BroadcastChannel;
  channelName?: string;
}): BroadcastChannelLike {
  if (!isBroadcastChannelAvailable() && !opts.channel) {
    return createNoopChannel();
  }

  // Acquire the BroadcastChannel.
  const channel = opts.channel ?? new globalThis.BroadcastChannel(opts.channelName ?? DEFAULT_CHANNEL_NAME);
  // Track whether we own the channel so close() only closes channels WE opened.
  const ownsChannel = !opts.channel;

  return {
    post(event) {
      try {
        channel.postMessage(event);
      } catch {
        // BroadcastChannel.postMessage can throw if the channel was closed
        // out-of-band. Swallow — same-tab consumers don't care.
      }
    },

    subscribe(listener) {
      const handler = (msg: MessageEvent<WalletStorageEvent>) => {
        // Guard against foreign messages on a shared channel.
        const data = msg?.data;
        if (
          data &&
          typeof data === 'object' &&
          (data.type === 'vouchers:changed' || data.type === 'transactions:changed') &&
          typeof data.source === 'string' &&
          typeof data.ts === 'number'
        ) {
          listener(data);
        }
      };
      channel.addEventListener('message', handler);
      return () => {
        try {
          channel.removeEventListener('message', handler);
        } catch {
          // ignore
        }
      };
    },

    close() {
      if (ownsChannel) {
        try {
          channel.close();
        } catch {
          // ignore
        }
      }
    },
  };
}

function createNoopChannel(): BroadcastChannelLike {
  return {
    post() {
      /* no-op */
    },
    subscribe() {
      return () => {
        /* no-op */
      };
    },
    close() {
      /* no-op */
    },
  };
}
