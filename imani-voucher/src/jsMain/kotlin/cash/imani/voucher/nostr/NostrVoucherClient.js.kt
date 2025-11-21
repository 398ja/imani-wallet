package cash.imani.voucher.nostr

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus

/**
 * JS stub implementation of NostrVoucherClient.
 *
 * Note: Full Nostr relay support is deferred due to nostr-tools ESM/CJS
 * compatibility issues with Kotlin/JS. This stub uses local storage only.
 *
 * TODO: Phase 3 - Implement proper Nostr relay sync using:
 * - Direct WebSocket implementation (bypassing nostr-tools)
 * - Or wait for Kotlin/JS ESM module support improvements
 */
actual class NostrVoucherClient(
    private val relayUrls: List<String>,
) {
    init {
        console.log("[NostrVoucherClient-JS] Stub implementation - Nostr sync disabled")
        console.log("[NostrVoucherClient-JS] Configured relays: ${relayUrls.joinToString()}")
    }

    actual suspend fun publishVoucher(voucher: StoredVoucher): Result<Unit> {
        // Stub: In production, would publish to Nostr relays
        console.log("[NostrVoucherClient-JS] STUB: Would publish voucher ${voucher.voucherId}")
        return Result.success(Unit)
    }

    actual suspend fun queryVoucher(voucherId: String): Result<StoredVoucher?> {
        // Stub: Returns null, cache-only mode
        console.log("[NostrVoucherClient-JS] STUB: Would query voucher $voucherId")
        return Result.success(null)
    }

    actual suspend fun queryVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>> {
        // Stub: Returns empty list, cache-only mode
        console.log("[NostrVoucherClient-JS] STUB: Would query vouchers by status $status")
        return Result.success(emptyList())
    }

    actual suspend fun queryVouchersByIssuer(issuerPubkey: String): Result<List<StoredVoucher>> {
        // Stub: Returns empty list, cache-only mode
        console.log("[NostrVoucherClient-JS] STUB: Would query vouchers by issuer")
        return Result.success(emptyList())
    }

    actual suspend fun updateVoucherStatus(
        voucherId: String,
        status: VoucherStatus,
    ): Result<Unit> {
        // Stub: No-op, cache handles updates locally
        console.log("[NostrVoucherClient-JS] STUB: Would update voucher $voucherId to $status")
        return Result.success(Unit)
    }

    /**
     * Closes all relay connections.
     * No-op in stub implementation.
     */
    fun close() {
        console.log("[NostrVoucherClient-JS] STUB: close() called")
    }
}

/**
 * Factory function for creating JS NostrVoucherClient.
 */
actual fun createNostrVoucherClient(relayUrls: List<String>): NostrVoucherClient {
    return NostrVoucherClient(relayUrls)
}
