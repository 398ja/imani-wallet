package cash.imani.voucher.nostr

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import xyz.tcheeric.wallet.core.nostr.InMemoryRelayClientFactory
import xyz.tcheeric.wallet.core.nostr.NostrGatewayService
import xyz.tcheeric.wallet.core.nostr.filter.NostrFilterBuilder
import java.time.Duration
import java.time.Instant
import xyz.tcheeric.wallet.core.nostr.NostrEvent as CashuNostrEvent

/**
 * JVM implementation of NostrVoucherClient using cashu-client's wallet-core-nostr.
 *
 * Supports two modes:
 * - In-memory: For testing (default when relay URL contains "localhost")
 * - Real relays: Connects to actual Nostr relays via NostrGatewayService
 *
 * Set environment variable NOSTR_USE_REAL_RELAYS=true to force real relay mode.
 *
 * Uses NIP-33 Parameterized Replaceable Events (kind 30078) for voucher storage.
 */
actual class NostrVoucherClient(
    private val relayUrls: List<String>,
) {
    private val useRealRelays: Boolean
    private val gateway: NostrGatewayService?

    // In-memory fallback storage
    private val inMemoryEvents: MutableMap<String, NostrEvent>

    companion object {
        private val sharedInMemoryEvents = mutableMapOf<String, NostrEvent>()

        /**
         * Clear in-memory storage (for testing only).
         */
        fun clearRelayForTesting() {
            sharedInMemoryEvents.clear()
        }
    }

    init {
        // Check environment variable for relay mode
        // - "true": Force real relay connections (even for localhost)
        // - "false": Force in-memory mode (for unit tests)
        // - unset: Auto-detect based on relay URL
        val relayModeEnv = System.getenv("NOSTR_USE_REAL_RELAYS")
        val isLocalRelay = relayUrls.any { it.contains("localhost") || it.contains("127.0.0.1") }

        useRealRelays = when (relayModeEnv?.lowercase()) {
            "true" -> true   // Force real relays
            "false" -> false // Force in-memory
            else -> !isLocalRelay // Auto: real for public, in-memory for localhost
        }
        inMemoryEvents = sharedInMemoryEvents

        if (useRealRelays) {
            println("[NostrVoucherClient-JVM] Connecting to real relays: ${relayUrls.joinToString()}")
            gateway = NostrGatewayService.createDefault()
            gateway.start()
        } else {
            println("[NostrVoucherClient-JVM] Using in-memory relay (local mode)")
            println("[NostrVoucherClient-JVM] Set NOSTR_USE_REAL_RELAYS=true to connect to real localhost relay")
            gateway = null
        }
    }

    actual suspend fun publishVoucher(voucher: StoredVoucher): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                if (useRealRelays && gateway != null) {
                    val event = createCashuEvent(voucher)
                    gateway.publish(event)
                    println("[NostrVoucherClient-JVM] Published voucher ${voucher.voucherId} to relays")
                } else {
                    val event = createInMemoryEvent(voucher)
                    inMemoryEvents[voucher.voucherId] = event
                    println("[NostrVoucherClient-JVM] Published voucher ${voucher.voucherId} (in-memory)")
                }
            }
        }

    actual suspend fun queryVoucher(voucherId: String): Result<StoredVoucher?> =
        withContext(Dispatchers.IO) {
            runCatching {
                if (useRealRelays && gateway != null) {
                    val filter = NostrFilterBuilder.newBuilder()
                        .kinds(VOUCHER_EVENT_KIND)
                        .tag("d", voucherId)
                        .limit(1)
                        .build()
                    val events = gateway.queryEvents(filter, Duration.ofSeconds(5))
                    events.firstOrNull()?.let { Json.decodeFromString<StoredVoucher>(it.content()) }
                } else {
                    inMemoryEvents[voucherId]?.let { parseInMemoryEvent(it) }
                }
            }
        }

    actual suspend fun queryVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                if (useRealRelays && gateway != null) {
                    val filter = NostrFilterBuilder.newBuilder()
                        .kinds(VOUCHER_EVENT_KIND)
                        .tag("status", status.name)
                        .limit(100)
                        .build()
                    gateway.queryEvents(filter, Duration.ofSeconds(5))
                        .mapNotNull { runCatching { Json.decodeFromString<StoredVoucher>(it.content()) }.getOrNull() }
                } else {
                    inMemoryEvents.values
                        .mapNotNull { parseInMemoryEvent(it) }
                        .filter { it.status == status }
                }
            }
        }

    actual suspend fun queryVouchersByIssuer(issuerPubkey: String): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                if (useRealRelays && gateway != null) {
                    val filter = NostrFilterBuilder.newBuilder()
                        .kinds(VOUCHER_EVENT_KIND)
                        .authors(issuerPubkey)
                        .limit(100)
                        .build()
                    gateway.queryEvents(filter, Duration.ofSeconds(5))
                        .mapNotNull { runCatching { Json.decodeFromString<StoredVoucher>(it.content()) }.getOrNull() }
                } else {
                    inMemoryEvents.values
                        .filter { it.pubkey == issuerPubkey }
                        .mapNotNull { parseInMemoryEvent(it) }
                }
            }
        }

    actual suspend fun updateVoucherStatus(
        voucherId: String,
        status: VoucherStatus,
    ): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val existingVoucher = queryVoucher(voucherId).getOrThrow()
                    ?: throw IllegalArgumentException("Voucher not found: $voucherId")

                val updatedVoucher = existingVoucher.copy(status = status)

                if (useRealRelays && gateway != null) {
                    val event = createCashuEvent(updatedVoucher)
                    gateway.publish(event)
                } else {
                    val event = createInMemoryEvent(updatedVoucher)
                    inMemoryEvents[voucherId] = event
                }
                println("[NostrVoucherClient-JVM] Updated voucher $voucherId status to $status")
            }
        }

    /**
     * Check if connected to real relays.
     */
    fun isUsingRealRelays(): Boolean = useRealRelays

    /**
     * Get relay health summary (only available with real relays).
     */
    fun getRelayHealthSummary(): Map<String, Double> =
        gateway?.relayHealthSummary ?: emptyMap()

    fun close() {
        gateway?.close()
        println("[NostrVoucherClient-JVM] Closed")
    }

    // --- Real relay event creation (cashu-client format) ---

    private fun createCashuEvent(voucher: StoredVoucher): CashuNostrEvent {
        val content = Json.encodeToString(voucher)
        val tags = listOf(
            listOf("d", voucher.voucherId),
            listOf("status", voucher.status.name),
            listOf("unit", voucher.unit),
            listOf("amount", voucher.faceValue.toString()),
        )
        return CashuNostrEvent.unsigned(
            voucher.issuerPublicKey,
            VOUCHER_EVENT_KIND,
            content,
            Instant.ofEpochSecond(voucher.issuedAt.epochSeconds),
            tags,
        )
    }

    // --- In-memory event creation (local format) ---

    private fun createInMemoryEvent(voucher: StoredVoucher): NostrEvent {
        val content = Json.encodeToString(voucher)
        val tags = listOf(
            listOf("d", voucher.voucherId),
            listOf("status", voucher.status.name),
            listOf("unit", voucher.unit),
            listOf("amount", voucher.faceValue.toString()),
        )
        return NostrEvent(
            id = "event_${voucher.voucherId}",
            pubkey = voucher.issuerPublicKey,
            created_at = voucher.issuedAt.epochSeconds,
            kind = VOUCHER_EVENT_KIND,
            tags = tags,
            content = content,
            sig = voucher.issuerSignature,
        )
    }

    private fun parseInMemoryEvent(event: NostrEvent): StoredVoucher {
        return Json.decodeFromString(event.content)
    }
}

/**
 * Factory function for creating JVM NostrVoucherClient.
 */
actual fun createNostrVoucherClient(relayUrls: List<String>): NostrVoucherClient {
    return NostrVoucherClient(relayUrls)
}
