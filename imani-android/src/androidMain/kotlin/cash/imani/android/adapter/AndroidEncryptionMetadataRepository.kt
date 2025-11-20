package cash.imani.android.adapter

import cash.imani.android.db.ImaniDatabase
import kotlinx.datetime.Clock
import xyz.tcheeric.wallet.core.security.EncryptionMetadataRepository

/**
 * Android implementation of cashu-client EncryptionMetadataRepository using SQLDelight.
 *
 * Stores encryption metadata (KDF parameters, salt, DEK IV/CT) in SQLite database.
 * Extends cashu-client's EncryptionMetadataRepository to maintain compatibility.
 *
 * **Single-Row Table**: Uses id=1 constraint to store only one encryption configuration,
 * matching cashu-client's file-based repository behavior.
 *
 * **Thread Safety**: All operations are synchronized to prevent concurrent modification
 * issues with SQLDelight database access.
 *
 * @property database SQLDelight database instance
 * @see xyz.tcheeric.wallet.core.security.EncryptionMetadataRepository
 */
class AndroidEncryptionMetadataRepository(
    private val database: ImaniDatabase,
) : EncryptionMetadataRepository() {
    private val queries = database.encryptionMetadataQueries

    /**
     * Loads encryption metadata from persistent storage.
     *
     * @return EncryptionMetadata if exists, null otherwise
     */
    @Synchronized
    override fun load(): EncryptionMetadata? {
        val entity = queries.selectMetadata().executeAsOneOrNull() ?: return null

        return EncryptionMetadata(
            entity.enabled != 0L,
            entity.version,
            entity.kdf,
            entity.kdfIter.toInt(),
            entity.salt,
            entity.dekIv,
            entity.dekCt,
        )
    }

    /**
     * Saves encryption metadata to persistent storage.
     *
     * **Atomic Operation**: Uses INSERT OR REPLACE to ensure single-row constraint.
     *
     * @param metadata EncryptionMetadata to persist
     */
    @Synchronized
    override fun save(metadata: EncryptionMetadata) {
        queries.insertOrReplaceMetadata(
            enabled = if (metadata.enabled()) 1L else 0L,
            version = metadata.version(),
            kdf = metadata.kdf(),
            kdfIter = metadata.kdfIter().toLong(),
            salt = metadata.salt(),
            dekIv = metadata.dekIv(),
            dekCt = metadata.dekCt(),
            updatedAt = Clock.System.now().toEpochMilliseconds(),
        )
    }
}
