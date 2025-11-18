package cash.imani.voucher.nostr

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import kotlinx.coroutines.await
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.js.json

/**
 * JS implementation of NostrVoucherClient using nostr-tools library.
 *
 * Uses the nostr-tools SimplePool for relay connectivity and event publishing.
 * Supports NIP-33 Parameterized Replaceable Events for voucher storage.
 *
 * Requirements:
 * - nostr-tools NPM package installed
 * - WebSocket support in browser
 */
actual class NostrVoucherClient(
    private val relayUrls: List<String>,
) {
    private val relayPool = SimplePool()
    private val relayArray = relayUrls.toTypedArray()

    actual suspend fun publishVoucher(voucher: StoredVoucher): Result<Unit> =
        runCatching {
            val event = createVoucherEvent(voucher)

            // Convert to JavaScript object for nostr-tools
            val jsEvent = eventToJsObject(event)

            // Publish to all relays
            relayPool.publish(relayArray, jsEvent).await()

            console.log("[NostrVoucherClient-JS] Published voucher ${voucher.voucherId} to ${relayUrls.size} relays")
        }

    actual suspend fun queryVoucher(voucherId: String): Result<StoredVoucher?> =
        runCatching {
            val filter =
                json(
                    "kinds" to arrayOf(VOUCHER_EVENT_KIND),
                    "#d" to arrayOf(voucherId),
                )

            val events = relayPool.querySync(relayArray, arrayOf(filter))

            if (events.isEmpty()) {
                null
            } else {
                // Get the most recent event (highest created_at)
                val latestEvent = events.maxByOrNull { event -> (event.asDynamic()).created_at as Long }
                latestEvent?.let {
                        jsEvent ->
                    jsEventToNostrEvent(jsEvent)
                }?.let { nostrEvent -> parseVoucherEvent(nostrEvent) }
            }
        }

    actual suspend fun queryVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>> =
        runCatching {
            val filter =
                json(
                    "kinds" to arrayOf(VOUCHER_EVENT_KIND),
                    "#status" to arrayOf(status.name),
                )

            val events = relayPool.querySync(relayArray, arrayOf(filter))

            events.mapNotNull { event ->
                jsEventToNostrEvent(event)?.let { parseVoucherEvent(it) }
            }
        }

    actual suspend fun queryVouchersByIssuer(issuerPubkey: String): Result<List<StoredVoucher>> =
        runCatching {
            val filter =
                json(
                    "kinds" to arrayOf(VOUCHER_EVENT_KIND),
                    "authors" to arrayOf(issuerPubkey),
                )

            val events = relayPool.querySync(relayArray, arrayOf(filter))

            events.mapNotNull { event ->
                jsEventToNostrEvent(event)?.let { parseVoucherEvent(it) }
            }
        }

    actual suspend fun updateVoucherStatus(
        voucherId: String,
        status: VoucherStatus,
    ): Result<Unit> =
        runCatching {
            // First query the existing voucher
            val existingVoucher =
                queryVoucher(voucherId).getOrThrow()
                    ?: throw IllegalArgumentException("Voucher not found: $voucherId")

            // Create updated voucher
            val updatedVoucher = existingVoucher.copy(status = status)

            // Publish replacement event (NIP-33 will replace old event with same 'd' tag)
            publishVoucher(updatedVoucher).getOrThrow()

            console.log("[NostrVoucherClient-JS] Updated voucher $voucherId status to $status")
        }

    private fun createVoucherEvent(voucher: StoredVoucher): NostrEvent {
        val content = Json.encodeToString(voucher)
        val tags =
            listOf(
                listOf("d", voucher.voucherId), // NIP-33 identifier
                listOf("status", voucher.status.name),
                listOf("unit", voucher.unit),
                listOf("amount", voucher.faceValue.toString()),
            )

        // For Phase 2, create simplified event
        // TODO: Phase 3 - Use proper event signing with private key
        return NostrEvent(
            id = "event_${voucher.voucherId}", // Simplified ID
            pubkey = voucher.issuerPublicKey,
            created_at = voucher.issuedAt.epochSeconds,
            kind = VOUCHER_EVENT_KIND,
            tags = tags,
            content = content,
            sig = voucher.issuerSignature, // Reuse voucher signature
        )
    }

    private fun parseVoucherEvent(event: NostrEvent): StoredVoucher {
        return Json.decodeFromString(event.content)
    }

    private fun eventToJsObject(event: NostrEvent): dynamic {
        return json(
            "id" to event.id,
            "pubkey" to event.pubkey,
            "created_at" to event.created_at,
            "kind" to event.kind,
            "tags" to event.tags.map { it.toTypedArray() }.toTypedArray(),
            "content" to event.content,
            "sig" to event.sig,
        )
    }

    private fun jsEventToNostrEvent(jsEvent: dynamic): NostrEvent? {
        return try {
            val tags =
                (jsEvent.tags as Array<dynamic>).map { tag ->
                    (tag as Array<dynamic>).map { it as String }
                }

            NostrEvent(
                id = jsEvent.id as String,
                pubkey = jsEvent.pubkey as String,
                created_at = (jsEvent.created_at as Number).toLong(),
                kind = jsEvent.kind as Int,
                tags = tags,
                content = jsEvent.content as String,
                sig = jsEvent.sig as String,
            )
        } catch (e: Exception) {
            console.error("[NostrVoucherClient-JS] Failed to parse event:", e.message)
            null
        }
    }

    /**
     * Closes all relay connections.
     * Should be called when the client is no longer needed.
     */
    fun close() {
        relayPool.close(relayArray)
    }
}

/**
 * Factory function for creating JS NostrVoucherClient.
 */
actual fun createNostrVoucherClient(relayUrls: List<String>): NostrVoucherClient {
    return NostrVoucherClient(relayUrls)
}
