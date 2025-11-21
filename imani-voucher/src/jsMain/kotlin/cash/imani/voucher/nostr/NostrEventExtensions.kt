package cash.imani.voucher.nostr

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/**
 * Convert NostrEvent to JSON object for relay communication.
 */
fun NostrEvent.toJsonObject(): JsonObject =
    buildJsonObject {
        id?.let { put("id", JsonPrimitive(it)) }
        put("pubkey", JsonPrimitive(pubkey))
        put("created_at", JsonPrimitive(created_at))
        put("kind", JsonPrimitive(kind))
        put(
            "tags",
            buildJsonArray {
                tags.forEach { tag ->
                    add(
                        buildJsonArray {
                            tag.forEach { add(JsonPrimitive(it)) }
                        },
                    )
                }
            },
        )
        put("content", JsonPrimitive(content))
        sig?.let { put("sig", JsonPrimitive(it)) }
    }

/**
 * Parse NostrEvent from JSON element.
 */
fun NostrEvent.Companion.fromJsonElement(json: JsonElement): NostrEvent {
    val obj = json.jsonObject
    return NostrEvent(
        id = obj["id"]?.jsonPrimitive?.content,
        pubkey = obj["pubkey"]!!.jsonPrimitive.content,
        created_at = obj["created_at"]!!.jsonPrimitive.long,
        kind = obj["kind"]!!.jsonPrimitive.content.toInt(),
        tags =
            obj["tags"]!!.jsonArray.map { tagArray ->
                tagArray.jsonArray.map { it.jsonPrimitive.content }
            },
        content = obj["content"]!!.jsonPrimitive.content,
        sig = obj["sig"]?.jsonPrimitive?.content,
    )
}

/**
 * Convert NostrFilter to JSON object for relay queries.
 */
fun NostrFilter.toJsonObject(): JsonObject =
    buildJsonObject {
        ids?.let { put("ids", buildJsonArray { it.forEach { add(JsonPrimitive(it)) } }) }
        authors?.let { put("authors", buildJsonArray { it.forEach { add(JsonPrimitive(it)) } }) }
        kinds?.let { put("kinds", buildJsonArray { it.forEach { add(JsonPrimitive(it)) } }) }
        tags?.forEach { (tag, values) ->
            put("#$tag", buildJsonArray { values.forEach { add(JsonPrimitive(it)) } })
        }
        since?.let { put("since", JsonPrimitive(it)) }
        until?.let { put("until", JsonPrimitive(it)) }
        limit?.let { put("limit", JsonPrimitive(it)) }
    }

/**
 * Compute NIP-01 event ID: SHA-256([0, pubkey, created_at, kind, tags, content])
 */
suspend fun NostrEvent.computeEventId(sha256: suspend (ByteArray) -> ByteArray): String {
    val serialized =
        buildJsonArray {
            add(JsonPrimitive(0))
            add(JsonPrimitive(pubkey))
            add(JsonPrimitive(created_at))
            add(JsonPrimitive(kind))
            add(
                buildJsonArray {
                    tags.forEach { tag ->
                        add(
                            buildJsonArray {
                                tag.forEach { add(JsonPrimitive(it)) }
                            },
                        )
                    }
                },
            )
            add(JsonPrimitive(content))
        }.toString()

    val hash = sha256(serialized.encodeToByteArray())
    return hash.toHexString()
}

/**
 * Convert ByteArray to hex string.
 */
private fun ByteArray.toHexString(): String = joinToString("") { it.toInt().and(0xFF).toString(16).padStart(2, '0') }
