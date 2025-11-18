package cash.imani.voucher.repository

import cash.imani.voucher.domain.Proof
import kotlin.js.Promise
import kotlinx.coroutines.await

/**
 * IndexedDB implementation of ProofRepository for web platform.
 *
 * Uses browser's IndexedDB API for persistent storage of Cashu proofs.
 *
 * Database schema:
 * - Database: "cashu_proofs"
 * - Object store: "proofs"
 * - Index: "mintUrl+unit" for querying by mint and unit
 * - Index: "secret" for deletion by secret
 *
 * Phase 2: Basic implementation with FIFO selection
 * Phase 3+: Add indices for faster queries, implement better coin selection
 */
actual fun createProofRepository(): ProofRepository = IndexedDBProofRepository()

class IndexedDBProofRepository : ProofRepository {
    private val dbName = "cashu_proofs"
    private val storeName = "proofs"
    private val dbVersion = 1

    /**
     * Opens (or creates) the IndexedDB database.
     */
    private suspend fun openDatabase(): dynamic {
        return suspendCoroutine { continuation ->
            val request = js("indexedDB.open(dbName, dbVersion)")
                .unsafeCast<dynamic>()

            request.onsuccess = { event: dynamic ->
                continuation.resume(event.target.result)
            }

            request.onerror = { event: dynamic ->
                continuation.resumeWithException(
                    Exception("Failed to open database: ${event.target.error}"),
                )
            }

            // Database upgrade (first time or version change)
            request.onupgradeneeded = { event: dynamic ->
                val db = event.target.result
                if (!db.objectStoreNames.contains(storeName)) {
                    val objectStore = db.createObjectStore(storeName, js("{ keyPath: 'secret' }"))
                    objectStore.createIndex("mintUrl", "mintUrl", js("{ unique: false }"))
                    objectStore.createIndex(
                        "mintUrl_unit",
                        arrayOf("mintUrl", "unit"),
                        js("{ unique: false }"),
                    )
                }
            }
        }
    }

    override suspend fun saveProofs(
        proofs: List<Proof>,
        mintUrl: String,
        unit: String,
    ): Result<Unit> =
        runCatching {
            val db = openDatabase()

            suspendCoroutine { continuation ->
                val tx = db.transaction(arrayOf(storeName), "readwrite")
                val store = tx.objectStore(storeName)

                proofs.forEach { proof ->
                    val record =
                        js(
                            """{
                        secret: proof.secret,
                        amount: proof.amount,
                        C: proof.C,
                        id: proof.id,
                        mintUrl: mintUrl,
                        unit: unit,
                        createdAt: Date.now()
                    }""",
                        )
                    store.add(record)
                }

                tx.oncomplete = {
                    db.close()
                    continuation.resume(Unit)
                }

                tx.onerror = { event: dynamic ->
                    db.close()
                    continuation.resumeWithException(
                        Exception("Failed to save proofs: ${event.target.error}"),
                    )
                }
            }
        }

    override suspend fun getProofs(
        mintUrl: String,
        unit: String,
    ): Result<List<Proof>> =
        runCatching {
            val db = openDatabase()

            suspendCoroutine { continuation ->
                val tx = db.transaction(arrayOf(storeName), "readonly")
                val store = tx.objectStore(storeName)
                val index = store.index("mintUrl_unit")
                val request = index.getAll(js("[ mintUrl, unit ]"))

                request.onsuccess = { event: dynamic ->
                    db.close()
                    val records = event.target.result.unsafeCast<Array<dynamic>>()
                    val proofs =
                        records.map { record ->
                            Proof(
                                amount = record.amount.unsafeCast<Int>(),
                                secret = record.secret.unsafeCast<String>(),
                                C = record.C.unsafeCast<String>(),
                                id = record.id.unsafeCast<String>(),
                            )
                        }
                    continuation.resume(proofs)
                }

                request.onerror = { event: dynamic ->
                    db.close()
                    continuation.resumeWithException(
                        Exception("Failed to get proofs: ${event.target.error}"),
                    )
                }
            }
        }

    override suspend fun selectProofs(
        amount: Long,
        mintUrl: String,
        unit: String,
    ): Result<List<Proof>> =
        runCatching {
            val allProofs = getProofs(mintUrl, unit).getOrThrow()

            // Simple FIFO selection: prefer smaller denominations first
            // This minimizes the number of proofs used and preserves privacy
            var remaining = amount
            val selected = mutableListOf<Proof>()

            for (proof in allProofs.sortedBy { it.amount }) {
                if (remaining <= 0) break
                selected.add(proof)
                remaining -= proof.amount
            }

            if (remaining > 0) {
                throw InsufficientBalanceException(
                    "Insufficient balance: need $remaining more sats (have ${amount - remaining}, need $amount)",
                )
            }

            selected
        }

    override suspend fun deleteProofs(secrets: List<String>): Result<Unit> =
        runCatching {
            val db = openDatabase()

            suspendCoroutine { continuation ->
                val tx = db.transaction(arrayOf(storeName), "readwrite")
                val store = tx.objectStore(storeName)

                secrets.forEach { secret ->
                    store.delete(secret)
                }

                tx.oncomplete = {
                    db.close()
                    continuation.resume(Unit)
                }

                tx.onerror = { event: dynamic ->
                    db.close()
                    continuation.resumeWithException(
                        Exception("Failed to delete proofs: ${event.target.error}"),
                    )
                }
            }
        }
}

/**
 * Suspends until the continuation is resumed.
 * Helper for converting callback-based IndexedDB API to coroutines.
 */
private suspend fun <T> suspendCoroutine(block: (Continuation<T>) -> Unit): T =
    kotlinx.coroutines.suspendCancellableCoroutine { continuation ->
        block(
            object : Continuation<T> {
                override fun resume(value: T) {
                    continuation.resumeWith(Result.success(value))
                }

                override fun resumeWithException(exception: Throwable) {
                    continuation.resumeWith(Result.failure(exception))
                }
            },
        )
    }

/**
 * Simple continuation interface for IndexedDB callbacks.
 */
private interface Continuation<T> {
    fun resume(value: T)

    fun resumeWithException(exception: Throwable)
}
