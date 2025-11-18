package cash.imani.voucher.repository

/**
 * External declarations for IndexedDB API.
 *
 * IndexedDB is a browser-based NoSQL database for storing large amounts of structured data.
 * These declarations allow Kotlin/JS to interact with the native IndexedDB API.
 *
 * References:
 * - https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API
 * - https://www.w3.org/TR/IndexedDB/
 */

/**
 * Main entry point to IndexedDB.
 */
external val indexedDB: IDBFactory

/**
 * Factory for creating/opening IndexedDB databases.
 */
external interface IDBFactory {
    /**
     * Opens a database connection.
     *
     * @param name Database name
     * @param version Database version (for migrations)
     * @return IDBOpenDBRequest with onsuccess, onerror, onupgradeneeded callbacks
     */
    fun open(
        name: String,
        version: Int,
    ): IDBOpenDBRequest

    /**
     * Deletes a database.
     *
     * @param name Database name
     * @return IDBOpenDBRequest
     */
    fun deleteDatabase(name: String): IDBOpenDBRequest
}

/**
 * Request for opening/creating a database.
 */
external interface IDBOpenDBRequest : IDBRequest {
    /**
     * Called when database needs to be created or upgraded.
     */
    var onupgradeneeded: ((IDBVersionChangeEvent) -> Unit)?
}

/**
 * Generic request for database operations.
 */
external interface IDBRequest {
    /**
     * Result of the request (available after onsuccess fires).
     */
    val result: dynamic

    /**
     * Error if request failed.
     */
    val error: dynamic

    /**
     * Called when request succeeds.
     */
    var onsuccess: ((dynamic) -> Unit)?

    /**
     * Called when request fails.
     */
    var onerror: ((dynamic) -> Unit)?
}

/**
 * Event fired when database version changes.
 */
external interface IDBVersionChangeEvent {
    /**
     * The target request.
     */
    val target: IDBOpenDBRequest

    /**
     * Old database version.
     */
    val oldVersion: Int

    /**
     * New database version.
     */
    val newVersion: Int?
}

/**
 * Database connection.
 */
external interface IDBDatabase {
    /**
     * Database name.
     */
    val name: String

    /**
     * Database version.
     */
    val version: Int

    /**
     * Names of all object stores in this database.
     */
    val objectStoreNames: dynamic

    /**
     * Creates a new object store.
     *
     * @param name Store name
     * @param options Store options (keyPath, autoIncrement)
     * @return IDBObjectStore
     */
    fun createObjectStore(
        name: String,
        options: dynamic = definedExternally,
    ): IDBObjectStore

    /**
     * Deletes an object store.
     *
     * @param name Store name
     */
    fun deleteObjectStore(name: String)

    /**
     * Creates a transaction for reading/writing data.
     *
     * @param storeNames Object store name(s) to access
     * @param mode Transaction mode ("readonly" or "readwrite")
     * @return IDBTransaction
     */
    fun transaction(
        storeNames: dynamic,
        mode: String = definedExternally,
    ): IDBTransaction

    /**
     * Closes the database connection.
     */
    fun close()
}

/**
 * Transaction for reading/writing data.
 */
external interface IDBTransaction {
    /**
     * Gets an object store from this transaction.
     *
     * @param name Store name
     * @return IDBObjectStore
     */
    fun objectStore(name: String): IDBObjectStore

    /**
     * Called when transaction completes successfully.
     */
    var oncomplete: ((dynamic) -> Unit)?

    /**
     * Called when transaction fails.
     */
    var onerror: ((dynamic) -> Unit)?

    /**
     * Called when transaction is aborted.
     */
    var onabort: ((dynamic) -> Unit)?
}

/**
 * Object store (similar to a table in SQL).
 */
external interface IDBObjectStore {
    /**
     * Store name.
     */
    val name: String

    /**
     * Store's key path.
     */
    val keyPath: dynamic

    /**
     * Adds a new record to the store.
     *
     * @param value The record to add
     * @param key Optional key (if keyPath not set)
     * @return IDBRequest
     */
    fun add(
        value: dynamic,
        key: dynamic = definedExternally,
    ): IDBRequest

    /**
     * Adds or updates a record in the store.
     *
     * @param value The record to put
     * @param key Optional key (if keyPath not set)
     * @return IDBRequest
     */
    fun put(
        value: dynamic,
        key: dynamic = definedExternally,
    ): IDBRequest

    /**
     * Gets a record by key.
     *
     * @param key The record key
     * @return IDBRequest
     */
    fun get(key: dynamic): IDBRequest

    /**
     * Deletes a record by key.
     *
     * @param key The record key
     * @return IDBRequest
     */
    fun delete(key: dynamic): IDBRequest

    /**
     * Clears all records from the store.
     *
     * @return IDBRequest
     */
    fun clear(): IDBRequest

    /**
     * Gets all records from the store.
     *
     * @param query Optional query (key or range)
     * @param count Optional max count
     * @return IDBRequest with result as Array
     */
    fun getAll(
        query: dynamic = definedExternally,
        count: Int = definedExternally,
    ): IDBRequest

    /**
     * Creates an index on the store.
     *
     * @param name Index name
     * @param keyPath Field(s) to index
     * @param options Index options (unique, multiEntry)
     * @return IDBIndex
     */
    fun createIndex(
        name: String,
        keyPath: dynamic,
        options: dynamic = definedExternally,
    ): IDBIndex

    /**
     * Gets an existing index.
     *
     * @param name Index name
     * @return IDBIndex
     */
    fun index(name: String): IDBIndex
}

/**
 * Index for querying records by non-primary key fields.
 */
external interface IDBIndex {
    /**
     * Index name.
     */
    val name: String

    /**
     * Index key path.
     */
    val keyPath: dynamic

    /**
     * Whether index values must be unique.
     */
    val unique: Boolean

    /**
     * Gets a record by index value.
     *
     * @param key The index value
     * @return IDBRequest
     */
    fun get(key: dynamic): IDBRequest

    /**
     * Gets all records matching an index value.
     *
     * @param query Index value or range
     * @param count Optional max count
     * @return IDBRequest with result as Array
     */
    fun getAll(
        query: dynamic = definedExternally,
        count: Int = definedExternally,
    ): IDBRequest
}
