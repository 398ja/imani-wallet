package cash.imani.android.adapter

import cash.imani.android.db.ImaniDatabase
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.datatype.jdk8.Jdk8Module
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.KotlinModule
import kotlinx.datetime.Clock
import xyz.tcheeric.wallet.core.WalletStorageException
import xyz.tcheeric.wallet.core.ports.WalletStorage
import xyz.tcheeric.wallet.core.state.WalletState
import java.util.Optional

/**
 * Android implementation of cashu-client WalletStorage using SQLDelight.
 *
 * Stores WalletState as JSON blobs in SQLite database. Uses Jackson ObjectMapper
 * for serialization/deserialization to match cashu-client's H2WalletStorageAdapter.
 *
 * **Thread Safety**: All operations are synchronized to prevent concurrent modification
 * issues with SQLDelight database access.
 *
 * **Error Handling**: Wraps all database and serialization errors in WalletStorageException
 * following cashu-client conventions.
 *
 * @property database SQLDelight database instance
 * @see xyz.tcheeric.wallet.core.ports.WalletStorage
 * @see xyz.tcheeric.wallet.core.H2WalletStorageAdapter
 */
class AndroidWalletStorage(
    private val database: ImaniDatabase,
) : WalletStorage {
    private val mapper: ObjectMapper =
        ObjectMapper()
            .registerModule(JavaTimeModule())
            .registerModule(Jdk8Module())
            .registerModule(KotlinModule.Builder().build())

    private val queries = database.walletStateQueries

    /**
     * Loads wallet state by wallet ID.
     *
     * @param walletId Unique wallet identifier (typically identity public key)
     * @return Optional containing WalletState if found, empty otherwise
     * @throws WalletStorageException on database or deserialization errors
     */
    @Synchronized
    override fun load(walletId: String): Optional<WalletState> =
        try {
            require(walletId.isNotBlank()) {
                "Wallet ID cannot be blank. Suggestion: Provide a valid wallet identifier."
            }

            val entity = queries.selectWalletState(walletId).executeAsOneOrNull()

            if (entity == null) {
                Optional.empty()
            } else {
                val walletState = mapper.readValue(entity.stateJson, WalletState::class.java)
                Optional.of(walletState)
            }
        } catch (e: IllegalArgumentException) {
            throw WalletStorageException(
                "Failed to load wallet state for '$walletId'. ${e.message}",
                e,
            )
        } catch (e: Exception) {
            throw WalletStorageException(
                "Failed to load wallet state for '$walletId'. " +
                    "Reason: ${e.javaClass.simpleName} - ${e.message}. " +
                    "Suggestion: Check database integrity and WalletState schema compatibility.",
                e,
            )
        }

    /**
     * Saves wallet state to persistent storage.
     *
     * @param walletId Unique wallet identifier
     * @param state WalletState to persist
     * @throws WalletStorageException on database or serialization errors
     */
    @Synchronized
    override fun save(
        walletId: String,
        state: WalletState,
    ) {
        try {
            require(walletId.isNotBlank()) {
                "Wallet ID cannot be blank. Suggestion: Provide a valid wallet identifier."
            }

            val stateJson = mapper.writeValueAsString(state)
            val now = Clock.System.now().toEpochMilliseconds()

            // Check if wallet exists to preserve createdAt timestamp
            val existing = queries.selectWalletState(walletId).executeAsOneOrNull()
            val createdAt = existing?.createdAt ?: now

            queries.insertOrReplaceWalletState(
                walletId = walletId,
                stateJson = stateJson,
                createdAt = createdAt,
                updatedAt = now,
            )
        } catch (e: IllegalArgumentException) {
            throw WalletStorageException(
                "Failed to save wallet state for '$walletId'. ${e.message}",
                e,
            )
        } catch (e: Exception) {
            throw WalletStorageException(
                "Failed to save wallet state for '$walletId'. " +
                    "Reason: ${e.javaClass.simpleName} - ${e.message}. " +
                    "Suggestion: Check database write permissions and available storage space.",
                e,
            )
        }
    }

    /**
     * Deletes wallet state by wallet ID.
     *
     * @param walletId Unique wallet identifier
     * @return true if wallet was deleted, false if wallet didn't exist
     * @throws WalletStorageException on database errors
     */
    @Synchronized
    override fun delete(walletId: String): Boolean =
        try {
            require(walletId.isNotBlank()) {
                "Wallet ID cannot be blank. Suggestion: Provide a valid wallet identifier."
            }

            val existedBefore = queries.checkWalletExists(walletId).executeAsOne()
            queries.deleteWalletState(walletId)
            existedBefore
        } catch (e: IllegalArgumentException) {
            throw WalletStorageException(
                "Failed to delete wallet state for '$walletId'. ${e.message}",
                e,
            )
        } catch (e: Exception) {
            throw WalletStorageException(
                "Failed to delete wallet state for '$walletId'. " +
                    "Reason: ${e.javaClass.simpleName} - ${e.message}. " +
                    "Suggestion: Check database integrity.",
                e,
            )
        }

    /**
     * Checks if wallet state exists.
     *
     * @param walletId Unique wallet identifier
     * @return true if wallet exists, false otherwise
     * @throws WalletStorageException on database errors
     */
    @Synchronized
    override fun exists(walletId: String): Boolean =
        try {
            require(walletId.isNotBlank()) {
                "Wallet ID cannot be blank. Suggestion: Provide a valid wallet identifier."
            }

            queries.checkWalletExists(walletId).executeAsOne()
        } catch (e: IllegalArgumentException) {
            throw WalletStorageException(
                "Failed to check wallet existence for '$walletId'. ${e.message}",
                e,
            )
        } catch (e: Exception) {
            throw WalletStorageException(
                "Failed to check wallet existence for '$walletId'. " +
                    "Reason: ${e.javaClass.simpleName} - ${e.message}. " +
                    "Suggestion: Check database integrity.",
                e,
            )
        }

    /**
     * Returns storage information for debugging and monitoring.
     *
     * @return Human-readable storage info (location, wallet count)
     */
    override fun getStorageInfo(): String {
        val walletCount =
            try {
                queries.countWalletStates().executeAsOne()
            } catch (e: Exception) {
                -1L
            }

        return "AndroidWalletStorage[database=ImaniDatabase, walletCount=$walletCount]"
    }
}
