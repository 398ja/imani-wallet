package cash.imani.voucher.repository

/**
 * JVM platform implementation of VoucherRepository factory.
 *
 * Creates a NostrVoucherRepository with:
 * - JVM in-memory Nostr client (Phase 2)
 * - JVM in-memory cache (ConcurrentHashMap)
 *
 * Phase 3 Enhancements:
 * - Integrate with cashu-client's NostrGatewayService
 * - Add optional SQLite/H2 persistence for cache
 * - Environment-based relay configuration
 */
actual fun createVoucherRepository(): VoucherRepository {
    // Sync from Nostr on startup
    return createNostrVoucherRepository(
        syncOnInit = true,
    )
}
