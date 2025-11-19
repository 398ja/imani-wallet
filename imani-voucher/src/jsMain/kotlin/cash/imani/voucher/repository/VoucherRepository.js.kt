package cash.imani.voucher.repository

/**
 * JS platform implementation of VoucherRepository factory.
 *
 * Creates a NostrVoucherRepository with:
 * - JS nostr-tools client for relay connectivity
 * - IndexedDB cache for browser persistence
 *
 * Features:
 * - Offline-first architecture (IndexedDB cache)
 * - Real-time sync with Nostr relays
 * - Multi-device synchronization via Nostr
 *
 * Browser Requirements:
 * - IndexedDB support (Chrome 24+, Firefox 16+, Safari 10+)
 * - WebSocket support for Nostr relays
 */
actual fun createVoucherRepository(): VoucherRepository {
    return createNostrVoucherRepository(
        // Sync from Nostr on startup
        syncOnInit = true,
    )
}
