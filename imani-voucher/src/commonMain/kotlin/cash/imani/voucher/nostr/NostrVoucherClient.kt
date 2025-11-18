package cash.imani.voucher.nostr

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus

/**
 * Platform-specific Nostr client for voucher operations.
 *
 * Uses NIP-33 (Parameterized Replaceable Events) for voucher storage on Nostr relays.
 * Event kind 30078 is used for voucher events.
 *
 * Platform implementations:
 * - JVM: Uses cashu-client's NostrGatewayService
 * - JS: Uses nostr-tools library via external declarations
 */
expect class NostrVoucherClient {
    /**
     * Publishes a voucher to configured Nostr relays.
     *
     * Creates a NIP-33 event (kind 30078) with the voucher data and publishes
     * it to all configured relays.
     *
     * @param voucher The voucher to publish
     * @return Result indicating success or failure
     */
    suspend fun publishVoucher(voucher: StoredVoucher): Result<Unit>

    /**
     * Queries a specific voucher by ID from Nostr relays.
     *
     * Searches for a NIP-33 event with the specified voucher ID in the 'd' tag.
     *
     * @param voucherId The voucher ID to search for
     * @return Result containing the voucher if found, null otherwise
     */
    suspend fun queryVoucher(voucherId: String): Result<StoredVoucher?>

    /**
     * Queries vouchers by status from Nostr relays.
     *
     * Filters events by the 'status' tag.
     *
     * @param status The voucher status to filter by
     * @return Result containing list of matching vouchers
     */
    suspend fun queryVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>>

    /**
     * Queries vouchers by issuer public key.
     *
     * Filters events by author (pubkey).
     *
     * @param issuerPubkey The issuer's public key (hex)
     * @return Result containing list of vouchers issued by this key
     */
    suspend fun queryVouchersByIssuer(issuerPubkey: String): Result<List<StoredVoucher>>

    /**
     * Updates a voucher's status on Nostr.
     *
     * Publishes a replacement NIP-33 event with the new status.
     * The event with the same 'd' tag (voucher ID) will replace the previous one.
     *
     * @param voucherId The voucher ID to update
     * @param status The new status
     * @return Result indicating success or failure
     */
    suspend fun updateVoucherStatus(voucherId: String, status: VoucherStatus): Result<Unit>
}

/**
 * Factory function for creating platform-specific NostrVoucherClient instances.
 *
 * @param relayUrls List of Nostr relay URLs to connect to
 * @return Platform-specific NostrVoucherClient implementation
 */
expect fun createNostrVoucherClient(relayUrls: List<String>): NostrVoucherClient
