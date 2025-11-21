package cash.imani.voucher.nostr

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import kotlinx.coroutines.await
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.khronos.webgl.Uint8Array
import kotlin.js.Promise

/**
 * JS implementation of NostrVoucherClient using WebSocket-based relay communication.
 *
 * Connects directly to Nostr relays using browser WebSocket API.
 * Uses NIP-33 Parameterized Replaceable Events (kind 30078) for voucher storage.
 */
actual class NostrVoucherClient(
    private val relayUrls: List<String>,
) {
    private val relay: WebSocketRelay = WebSocketRelay(relayUrls.first())
    private var isConnected = false

    init {
        console.log("[NostrVoucherClient-JS] Configured for relay: ${relayUrls.first()}")
    }

    private suspend fun ensureConnected() {
        if (!isConnected) {
            relay.connect().getOrThrow()
            isConnected = true
            console.log("[NostrVoucherClient-JS] Connected to relay")
        }
    }

    actual suspend fun publishVoucher(voucher: StoredVoucher): Result<Unit> =
        runCatching {
            ensureConnected()

            val event = createVoucherEvent(voucher)
            relay.publish(event).getOrThrow()

            console.log("[NostrVoucherClient-JS] Published voucher ${voucher.voucherId}")
        }

    actual suspend fun queryVoucher(voucherId: String): Result<StoredVoucher?> =
        runCatching {
            ensureConnected()

            val filter =
                NostrFilter(
                    kinds = listOf(VOUCHER_EVENT_KIND),
                    tags = mapOf("d" to listOf(voucherId)),
                    limit = 1,
                )

            val events = relay.query(filter).getOrThrow()
            events.firstOrNull()?.let { parseVoucherEvent(it) }
        }

    actual suspend fun queryVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>> =
        runCatching {
            ensureConnected()

            val filter =
                NostrFilter(
                    kinds = listOf(VOUCHER_EVENT_KIND),
                    tags = mapOf("status" to listOf(status.name)),
                    limit = 100,
                )

            val events = relay.query(filter).getOrThrow()
            events.mapNotNull { runCatching { parseVoucherEvent(it) }.getOrNull() }
        }

    actual suspend fun queryVouchersByIssuer(issuerPubkey: String): Result<List<StoredVoucher>> =
        runCatching {
            ensureConnected()

            val filter =
                NostrFilter(
                    authors = listOf(issuerPubkey),
                    kinds = listOf(VOUCHER_EVENT_KIND),
                    limit = 100,
                )

            val events = relay.query(filter).getOrThrow()
            events.mapNotNull { runCatching { parseVoucherEvent(it) }.getOrNull() }
        }

    actual suspend fun updateVoucherStatus(
        voucherId: String,
        status: VoucherStatus,
    ): Result<Unit> =
        runCatching {
            val existingVoucher =
                queryVoucher(voucherId).getOrThrow()
                    ?: throw IllegalArgumentException("Voucher not found: $voucherId")

            val updatedVoucher = existingVoucher.copy(status = status)
            publishVoucher(updatedVoucher).getOrThrow()

            console.log("[NostrVoucherClient-JS] Updated voucher $voucherId status to $status")
        }

    fun close() {
        relay.close()
        isConnected = false
        console.log("[NostrVoucherClient-JS] Closed")
    }

    /**
     * Create a signed NIP-33 event for a voucher.
     */
    private suspend fun createVoucherEvent(voucher: StoredVoucher): NostrEvent {
        val content = Json.encodeToString(voucher)
        val tags =
            listOf(
                listOf("d", voucher.voucherId),
                listOf("status", voucher.status.name),
                listOf("unit", voucher.unit),
                listOf("amount", voucher.faceValue.toString()),
            )

        val unsignedEvent =
            NostrEvent(
                id = null,
                pubkey = voucher.issuerPublicKey,
                created_at = voucher.issuedAt.epochSeconds,
                kind = VOUCHER_EVENT_KIND,
                tags = tags,
                content = content,
                sig = null,
            )

        // Compute event ID (SHA-256)
        val eventId = unsignedEvent.computeEventId(::sha256)

        // Sign with voucher's signature (reuse existing signature for now)
        // TODO: Proper Nostr event signing requires the private key
        // For now, we reuse the voucher's issuer signature
        val sig = voucher.issuerSignature

        return unsignedEvent.copy(id = eventId, sig = sig)
    }

    private fun parseVoucherEvent(event: NostrEvent): StoredVoucher {
        return Json.decodeFromString(event.content)
    }

    /**
     * SHA-256 hash using Web Crypto API.
     */
    private suspend fun sha256(data: ByteArray): ByteArray {
        val jsArray = data.toTypedArray()
        val buffer = Uint8Array(jsArray.unsafeCast<Array<Byte>>())
        val hashBuffer = crypto.subtle.digest("SHA-256", buffer).await()
        val resultArray = Uint8Array(hashBuffer.unsafeCast<org.khronos.webgl.ArrayBuffer>())
        return ByteArray(resultArray.length) { i -> resultArray.asDynamic()[i].unsafeCast<Number>().toByte() }
    }
}

/**
 * Access to Web Crypto API.
 */
private external val crypto: Crypto

private external interface Crypto {
    val subtle: SubtleCrypto
}

private external interface SubtleCrypto {
    fun digest(
        algorithm: String,
        data: dynamic,
    ): Promise<dynamic>
}

actual fun createNostrVoucherClient(relayUrls: List<String>): NostrVoucherClient = NostrVoucherClient(relayUrls)
