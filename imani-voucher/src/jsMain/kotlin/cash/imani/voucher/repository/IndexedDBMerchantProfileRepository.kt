package cash.imani.voucher.repository

import cash.imani.voucher.domain.MerchantProfile
import kotlinx.coroutines.await
import kotlinx.datetime.Clock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.js.Promise

/**
 * IndexedDB implementation of MerchantProfileRepository for web platform.
 *
 * Stores merchant profiles in browser's IndexedDB for offline access.
 * Future enhancement: Sync with Nostr relays for cross-device profiles.
 *
 * **Database Schema**:
 * - Database: `imani_merchant_profiles`
 * - Store: `profiles`
 * - Key: `merchantId` (Nostr npub)
 * - Indexes: `businessName`, `updatedAt`
 *
 * **Storage Format**:
 * ```javascript
 * {
 *   merchantId: "npub1...",
 *   data: "{JSON-encoded MerchantProfile}",
 *   _lastSyncAt: 1234567890
 * }
 * ```
 *
 * @see MerchantProfileRepository Interface specification
 * @see MerchantProfile Domain model
 */
class IndexedDBMerchantProfileRepository : MerchantProfileRepository {
    companion object {
        private const val DB_NAME = "imani_merchant_profiles"
        private const val DB_VERSION = 1
        private const val STORE_NAME = "profiles"
    }

    /**
     * Opens IndexedDB database and creates object store if needed.
     *
     * @return Promise resolving to IDBDatabase
     */
    private fun openDatabase(): Promise<dynamic> {
        return Promise { resolve, reject ->
            val request = js("indexedDB.open(DB_NAME, DB_VERSION)")

            request.onsuccess = {
                resolve(request.result)
            }

            request.onerror = {
                reject(Exception("Failed to open IndexedDB: ${request.error}"))
            }

            request.onupgradeneeded = { event: dynamic ->
                val db = event.target.result
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    val store = db.createObjectStore(STORE_NAME, js("({keyPath: 'merchantId'})"))
                    store.createIndex("businessName", "businessName", js("({unique: false})"))
                    store.createIndex("updatedAt", "updatedAt", js("({unique: false})"))
                }
            }
        }
    }

    override suspend fun getProfile(merchantId: String): Result<MerchantProfile> =
        runCatching {
            val db = openDatabase().await()
            val tx = db.transaction(arrayOf(STORE_NAME), "readonly")
            val store = tx.objectStore(STORE_NAME)
            val request = store.get(merchantId)

            val record: dynamic =
                Promise<dynamic> { resolve, reject ->
                    request.onsuccess = { resolve(request.result) }
                    request.onerror = { reject(request.error) }
                }.await()

            db.close()

            if (record == null || record == js("undefined")) {
                throw MerchantProfileNotFoundException("Profile not found for merchant: $merchantId")
            }

            val profileJson = record.data as String
            Json.decodeFromString<MerchantProfile>(profileJson)
        }

    override suspend fun saveProfile(profile: MerchantProfile): Result<Unit> =
        runCatching {
            val db = openDatabase().await()
            val tx = db.transaction(arrayOf(STORE_NAME), "readwrite")
            val store = tx.objectStore(STORE_NAME)

            val profileJson = Json.encodeToString(profile)
            val record = js("({})")
            record.merchantId = profile.merchantId
            record.businessName = profile.businessName
            record.updatedAt = profile.updatedAt.toEpochMilliseconds()
            record.data = profileJson
            record._lastSyncAt = js("Date.now()")

            store.put(record)

            Promise<Unit> { resolve, reject ->
                tx.oncomplete = { resolve(Unit) }
                tx.onerror = { reject(tx.error) }
            }.await()

            db.close()
        }

    override suspend fun deleteProfile(merchantId: String): Result<Unit> =
        runCatching {
            val db = openDatabase().await()
            val tx = db.transaction(arrayOf(STORE_NAME), "readwrite")
            val store = tx.objectStore(STORE_NAME)

            store.delete(merchantId)

            Promise<Unit> { resolve, reject ->
                tx.oncomplete = { resolve(Unit) }
                tx.onerror = { reject(tx.error) }
            }.await()

            db.close()
        }
}

/**
 * Exception thrown when merchant profile is not found.
 *
 * @param message Error description
 */
class MerchantProfileNotFoundException(message: String) : Exception(message)
