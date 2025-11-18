package cash.imani.voucher.repository

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import kotlinx.coroutines.await
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import kotlin.js.json

/**
 * IndexedDB implementation of VoucherCacheRepository for JS platform.
 *
 * Uses browser's IndexedDB API for persistent offline storage of vouchers.
 * Provides fast local access with indexed queries by status and issuer.
 *
 * Database Schema:
 * - vouchers: Main store with voucherId as primary key
 *   - Indices: status, issuerPublicKey
 * - metadata: Sync metadata store
 *   - Key: "lastSyncTime"
 *
 * Browser Support:
 * - Chrome 24+
 * - Firefox 16+
 * - Safari 10+
 * - Edge 79+
 */
class IndexedDBVoucherCache : VoucherCacheRepository {
    private val dbName = "imani-voucher-cache"
    private val dbVersion = 1
    private val voucherStoreName = "vouchers"
    private val metadataStoreName = "metadata"

    private var db: IDBDatabase? = null

    /**
     * Opens the IndexedDB database, creating it if needed.
     */
    private suspend fun getDatabase(): IDBDatabase {
        // Return cached connection if available
        db?.let { return it }

        return suspendCoroutine { continuation ->
            val request = indexedDB.open(dbName, dbVersion)

            request.onupgradeneeded = { event ->
                try {
                    val database = (event.target as IDBOpenDBRequest).result as IDBDatabase

                    // Create vouchers object store if it doesn't exist
                    if (!database.objectStoreNames.contains(voucherStoreName)) {
                        val voucherStore = database.createObjectStore(
                            voucherStoreName,
                            json("keyPath" to "voucherId")
                        )

                        // Create indices for querying
                        voucherStore.createIndex("status", "status", json("unique" to false))
                        voucherStore.createIndex("issuerPublicKey", "issuerPublicKey", json("unique" to false))

                        console.log("[IndexedDBVoucherCache] Created vouchers object store with indices")
                    }

                    // Create metadata object store if it doesn't exist
                    if (!database.objectStoreNames.contains(metadataStoreName)) {
                        database.createObjectStore(
                            metadataStoreName,
                            json("keyPath" to "key")
                        )

                        console.log("[IndexedDBVoucherCache] Created metadata object store")
                    }
                } catch (e: Throwable) {
                    console.error("[IndexedDBVoucherCache] Error during database upgrade:", e.message)
                }
            }

            request.onsuccess = {
                val database = request.result as IDBDatabase
                db = database
                console.log("[IndexedDBVoucherCache] Database opened successfully")
                continuation.resume(database)
            }

            request.onerror = {
                val error = request.error
                console.error("[IndexedDBVoucherCache] Failed to open database:", error)
                continuation.resumeWithException(
                    Exception("Failed to open IndexedDB: ${error}")
                )
            }
        }
    }

    override suspend fun saveVoucher(voucher: StoredVoucher): Result<Unit> =
        runCatching {
            val database = getDatabase()

            suspendCoroutine { continuation ->
                val transaction = database.transaction(voucherStoreName, "readwrite")
                val store = transaction.objectStore(voucherStoreName)

                // Convert voucher to JavaScript object
                val voucherJson = Json.encodeToString(voucher)
                val voucherObj = JSON.parse<dynamic>(voucherJson)

                val request = store.put(voucherObj)

                request.onsuccess = {
                    console.log("[IndexedDBVoucherCache] Saved voucher ${voucher.voucherId}")
                    continuation.resume(Unit)
                }

                request.onerror = {
                    console.error("[IndexedDBVoucherCache] Error saving voucher:", request.error)
                    continuation.resumeWithException(
                        Exception("Failed to save voucher: ${request.error}")
                    )
                }
            }
        }

    override suspend fun getVoucher(voucherId: String): Result<StoredVoucher?> =
        runCatching {
            val database = getDatabase()

            suspendCoroutine { continuation ->
                val transaction = database.transaction(voucherStoreName, "readonly")
                val store = transaction.objectStore(voucherStoreName)
                val request = store.get(voucherId)

                request.onsuccess = {
                    val result = request.result
                    if (result == null || result == undefined) {
                        console.log("[IndexedDBVoucherCache] Voucher not found: $voucherId")
                        continuation.resume(null)
                    } else {
                        try {
                            val voucherJson = JSON.stringify(result)
                            val voucher = Json.decodeFromString<StoredVoucher>(voucherJson)
                            console.log("[IndexedDBVoucherCache] Retrieved voucher $voucherId")
                            continuation.resume(voucher)
                        } catch (e: Exception) {
                            console.error("[IndexedDBVoucherCache] Error parsing voucher:", e.message)
                            continuation.resumeWithException(e)
                        }
                    }
                }

                request.onerror = {
                    console.error("[IndexedDBVoucherCache] Error getting voucher:", request.error)
                    continuation.resumeWithException(
                        Exception("Failed to get voucher: ${request.error}")
                    )
                }
            }
        }

    override suspend fun listVouchers(): Result<List<StoredVoucher>> =
        runCatching {
            val database = getDatabase()

            suspendCoroutine { continuation ->
                val transaction = database.transaction(voucherStoreName, "readonly")
                val store = transaction.objectStore(voucherStoreName)
                val request = store.getAll()

                request.onsuccess = {
                    try {
                        val results = request.result as? Array<dynamic> ?: emptyArray()
                        val vouchers = results.map { result ->
                            val voucherJson = JSON.stringify(result)
                            Json.decodeFromString<StoredVoucher>(voucherJson)
                        }
                        console.log("[IndexedDBVoucherCache] Listed ${vouchers.size} vouchers")
                        continuation.resume(vouchers)
                    } catch (e: Exception) {
                        console.error("[IndexedDBVoucherCache] Error parsing vouchers:", e.message)
                        continuation.resumeWithException(e)
                    }
                }

                request.onerror = {
                    console.error("[IndexedDBVoucherCache] Error listing vouchers:", request.error)
                    continuation.resumeWithException(
                        Exception("Failed to list vouchers: ${request.error}")
                    )
                }
            }
        }

    override suspend fun getVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>> =
        runCatching {
            val database = getDatabase()

            suspendCoroutine { continuation ->
                val transaction = database.transaction(voucherStoreName, "readonly")
                val store = transaction.objectStore(voucherStoreName)
                val index = store.index("status")
                val request = index.getAll(status.name)

                request.onsuccess = {
                    try {
                        val results = request.result as? Array<dynamic> ?: emptyArray()
                        val vouchers = results.map { result ->
                            val voucherJson = JSON.stringify(result)
                            Json.decodeFromString<StoredVoucher>(voucherJson)
                        }
                        console.log("[IndexedDBVoucherCache] Found ${vouchers.size} vouchers with status $status")
                        continuation.resume(vouchers)
                    } catch (e: Exception) {
                        console.error("[IndexedDBVoucherCache] Error parsing vouchers:", e.message)
                        continuation.resumeWithException(e)
                    }
                }

                request.onerror = {
                    console.error("[IndexedDBVoucherCache] Error querying by status:", request.error)
                    continuation.resumeWithException(
                        Exception("Failed to query by status: ${request.error}")
                    )
                }
            }
        }

    override suspend fun getVouchersByIssuer(issuerPubkey: String): Result<List<StoredVoucher>> =
        runCatching {
            val database = getDatabase()

            suspendCoroutine { continuation ->
                val transaction = database.transaction(voucherStoreName, "readonly")
                val store = transaction.objectStore(voucherStoreName)
                val index = store.index("issuerPublicKey")
                val request = index.getAll(issuerPubkey)

                request.onsuccess = {
                    try {
                        val results = request.result as? Array<dynamic> ?: emptyArray()
                        val vouchers = results.map { result ->
                            val voucherJson = JSON.stringify(result)
                            Json.decodeFromString<StoredVoucher>(voucherJson)
                        }
                        console.log("[IndexedDBVoucherCache] Found ${vouchers.size} vouchers from issuer $issuerPubkey")
                        continuation.resume(vouchers)
                    } catch (e: Exception) {
                        console.error("[IndexedDBVoucherCache] Error parsing vouchers:", e.message)
                        continuation.resumeWithException(e)
                    }
                }

                request.onerror = {
                    console.error("[IndexedDBVoucherCache] Error querying by issuer:", request.error)
                    continuation.resumeWithException(
                        Exception("Failed to query by issuer: ${request.error}")
                    )
                }
            }
        }

    override suspend fun updateVoucherStatus(voucherId: String, status: VoucherStatus): Result<Unit> =
        runCatching {
            // Get existing voucher
            val voucher = getVoucher(voucherId).getOrThrow()
                ?: throw IllegalArgumentException("Voucher not found: $voucherId")

            // Update status
            val updatedVoucher = voucher.copy(status = status)

            // Save updated voucher
            saveVoucher(updatedVoucher).getOrThrow()

            console.log("[IndexedDBVoucherCache] Updated voucher $voucherId status to $status")
        }

    override suspend fun deleteVoucher(voucherId: String): Result<Unit> =
        runCatching {
            val database = getDatabase()

            suspendCoroutine { continuation ->
                val transaction = database.transaction(voucherStoreName, "readwrite")
                val store = transaction.objectStore(voucherStoreName)
                val request = store.delete(voucherId)

                request.onsuccess = {
                    console.log("[IndexedDBVoucherCache] Deleted voucher $voucherId")
                    continuation.resume(Unit)
                }

                request.onerror = {
                    console.error("[IndexedDBVoucherCache] Error deleting voucher:", request.error)
                    continuation.resumeWithException(
                        Exception("Failed to delete voucher: ${request.error}")
                    )
                }
            }
        }

    override suspend fun clearAll(): Result<Unit> =
        runCatching {
            val database = getDatabase()

            suspendCoroutine { continuation ->
                val transaction = database.transaction(voucherStoreName, "readwrite")
                val store = transaction.objectStore(voucherStoreName)
                val request = store.clear()

                request.onsuccess = {
                    console.log("[IndexedDBVoucherCache] Cleared all vouchers")
                    continuation.resume(Unit)
                }

                request.onerror = {
                    console.error("[IndexedDBVoucherCache] Error clearing vouchers:", request.error)
                    continuation.resumeWithException(
                        Exception("Failed to clear vouchers: ${request.error}")
                    )
                }
            }
        }

    override suspend fun getLastSyncTime(): Result<Long?> =
        runCatching {
            val database = getDatabase()

            suspendCoroutine { continuation ->
                val transaction = database.transaction(metadataStoreName, "readonly")
                val store = transaction.objectStore(metadataStoreName)
                val request = store.get("lastSyncTime")

                request.onsuccess = {
                    val result = request.result
                    if (result == null || result == undefined) {
                        console.log("[IndexedDBVoucherCache] No last sync time found")
                        continuation.resume(null)
                    } else {
                        val timestamp = result.asDynamic().value as? Long
                        console.log("[IndexedDBVoucherCache] Last sync time: $timestamp")
                        continuation.resume(timestamp)
                    }
                }

                request.onerror = {
                    console.error("[IndexedDBVoucherCache] Error getting last sync time:", request.error)
                    continuation.resumeWithException(
                        Exception("Failed to get last sync time: ${request.error}")
                    )
                }
            }
        }

    override suspend fun setLastSyncTime(timestamp: Long): Result<Unit> =
        runCatching {
            val database = getDatabase()

            suspendCoroutine { continuation ->
                val transaction = database.transaction(metadataStoreName, "readwrite")
                val store = transaction.objectStore(metadataStoreName)

                val metadata = json(
                    "key" to "lastSyncTime",
                    "value" to timestamp
                )

                val request = store.put(metadata)

                request.onsuccess = {
                    console.log("[IndexedDBVoucherCache] Set last sync time to $timestamp")
                    continuation.resume(Unit)
                }

                request.onerror = {
                    console.error("[IndexedDBVoucherCache] Error setting last sync time:", request.error)
                    continuation.resumeWithException(
                        Exception("Failed to set last sync time: ${request.error}")
                    )
                }
            }
        }

    /**
     * Closes the database connection.
     * Should be called when the cache is no longer needed.
     */
    fun close() {
        db?.close()
        db = null
        console.log("[IndexedDBVoucherCache] Database connection closed")
    }
}

/**
 * Factory function for creating IndexedDB cache on JS platform.
 */
actual fun createVoucherCacheRepository(): VoucherCacheRepository {
    return IndexedDBVoucherCache()
}
