package cash.imani.android.repository

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import app.cash.sqldelight.coroutines.mapToOneOrNull
import cash.imani.android.db.ImaniDatabase
import cash.imani.android.identity.AndroidIdentityManager
import cash.imani.identity.domain.Identity
import cash.imani.identity.repository.IdentityRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import kotlinx.datetime.Instant

/**
 * Android implementation of IdentityRepository using SQLDelight.
 *
 * This is a thin wrapper that:
 * 1. Uses imani-identity domain models (Identity)
 * 2. Stores encrypted private keys via AndroidIdentityManager (Android Keystore)
 * 3. Persists identity metadata in SQLDelight database
 *
 * Code Reuse:
 * - Domain model: cash.imani.identity.domain.Identity (100% reused)
 * - Encryption: AndroidIdentityManager wraps Android Keystore
 * - Persistence: SQLDelight generated queries
 */
class AndroidIdentityRepository(
    private val database: ImaniDatabase,
    private val identityManager: AndroidIdentityManager
) : IdentityRepository {

    private val queries = database.identityQueries

    override suspend fun createIdentity(label: String): Result<Identity> = withContext(Dispatchers.IO) {
        runCatching {
            // NOTE: Identity generation delegated to use cases (CreateIdentityUseCase)
            // This method is kept for interface compatibility but should be called after identity is generated
            throw UnsupportedOperationException(
                "Use CreateIdentityUseCase for identity generation, then call saveIdentity()"
            )
        }
    }

    /**
     * Save an existing identity to the database with encrypted private key.
     */
    suspend fun saveIdentity(identity: Identity): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            // 1. Encrypt private key using Android Keystore
            val (identityWithoutPrivKey, encryptedPrivKey) = identityManager.prepareForStorage(identity)

            // 2. Store in SQLDelight
            queries.insert(
                id = identityWithoutPrivKey.id,
                label = identityWithoutPrivKey.label,
                publicKey = identityWithoutPrivKey.publicKey,
                encryptedPrivateKey = encryptedPrivKey,
                createdAt = identityWithoutPrivKey.createdAt.toEpochMilliseconds(),
                lastUsedAt = identityWithoutPrivKey.lastUsedAt?.toEpochMilliseconds()
            )
        }
    }

    override suspend fun listIdentities(): Result<List<Identity>> = withContext(Dispatchers.IO) {
        runCatching {
            queries.selectAll()
                .executeAsList()
                .map { entity ->
                    Identity(
                        id = entity.id,
                        label = entity.label,
                        publicKey = entity.publicKey,
                        privateKey = identityManager.decryptPrivateKey(entity.id, entity.encryptedPrivateKey),
                        createdAt = Instant.fromEpochMilliseconds(entity.createdAt),
                        lastUsedAt = entity.lastUsedAt?.let { Instant.fromEpochMilliseconds(it) }
                    )
                }
        }
    }

    override suspend fun getIdentity(id: String): Result<Identity> = withContext(Dispatchers.IO) {
        runCatching {
            val entity = queries.selectById(id).executeAsOneOrNull()
                ?: throw IdentityNotFoundException(id)

            Identity(
                id = entity.id,
                label = entity.label,
                publicKey = entity.publicKey,
                privateKey = identityManager.decryptPrivateKey(entity.id, entity.encryptedPrivateKey),
                createdAt = Instant.fromEpochMilliseconds(entity.createdAt),
                lastUsedAt = entity.lastUsedAt?.let { Instant.fromEpochMilliseconds(it) }
            )
        }
    }

    override suspend fun deleteIdentity(id: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            // 1. Delete from database
            queries.deleteById(id)

            // 2. Delete encrypted private key from Keystore
            identityManager.deletePrivateKey(id)
        }
    }

    override suspend fun importFromMnemonic(mnemonic: String, label: String): Result<Identity> = withContext(Dispatchers.IO) {
        runCatching {
            // NOTE: Identity import from mnemonic delegated to use cases (ImportIdentityUseCase)
            throw UnsupportedOperationException(
                "Use ImportIdentityUseCase for mnemonic import, then call saveIdentity()"
            )
        }
    }

    override suspend fun exportMnemonic(id: String): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            // NOTE: Mnemonic export delegated to use cases (ExportMnemonicUseCase)
            throw UnsupportedOperationException(
                "Use ExportMnemonicUseCase for mnemonic export"
            )
        }
    }

    override suspend fun updateLabel(id: String, newLabel: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            require(newLabel.trim().length in 1..100) {
                "Label must be 1-100 characters, got ${newLabel.trim().length}"
            }
            queries.updateLabel(label = newLabel.trim(), id = id)
        }
    }

    override suspend fun markAsUsed(id: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val now = kotlinx.datetime.Clock.System.now().toEpochMilliseconds()
            queries.updateLastUsed(lastUsedAt = now, id = id)
        }
    }

    /**
     * Observe all identities as a Flow (for reactive UI).
     */
    fun observeIdentities(): Flow<List<Identity>> {
        return queries.selectAll()
            .asFlow()
            .mapToList(Dispatchers.IO)
            .map { entities ->
                entities.map { entity ->
                    Identity(
                        id = entity.id,
                        label = entity.label,
                        publicKey = entity.publicKey,
                        privateKey = identityManager.decryptPrivateKey(entity.id, entity.encryptedPrivateKey),
                        createdAt = Instant.fromEpochMilliseconds(entity.createdAt),
                        lastUsedAt = entity.lastUsedAt?.let { Instant.fromEpochMilliseconds(it) }
                    )
                }
            }
    }

    /**
     * Observe a single identity by ID as a Flow.
     */
    fun observeIdentity(id: String): Flow<Identity?> {
        return queries.selectById(id)
            .asFlow()
            .mapToOneOrNull(Dispatchers.IO)
            .map { entity ->
                entity?.let {
                    Identity(
                        id = it.id,
                        label = it.label,
                        publicKey = it.publicKey,
                        privateKey = identityManager.decryptPrivateKey(it.id, it.encryptedPrivateKey),
                        createdAt = Instant.fromEpochMilliseconds(it.createdAt),
                        lastUsedAt = it.lastUsedAt?.let { ts -> Instant.fromEpochMilliseconds(ts) }
                    )
                }
            }
    }
}

/**
 * Thrown when an identity is not found in the repository.
 */
class IdentityNotFoundException(id: String) : Exception("Identity not found: $id")
