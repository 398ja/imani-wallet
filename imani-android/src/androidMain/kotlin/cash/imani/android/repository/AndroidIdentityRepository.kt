package cash.imani.android.repository

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import app.cash.sqldelight.coroutines.mapToOneOrNull
import cash.imani.android.db.ImaniDatabase
import cash.imani.android.identity.AndroidIdentityManager
import cash.imani.identity.crypto.Bip39Adapter
import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.domain.Identity
import cash.imani.identity.repository.IdentityRepository
import cash.imani.identity.util.toHex
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import java.util.UUID

/**
 * Android implementation of IdentityRepository using SQLDelight.
 *
 * This is a thin wrapper that:
 * 1. Uses imani-identity domain models (Identity)
 * 2. Stores encrypted private keys via AndroidIdentityManager (Android Keystore)
 * 3. Persists identity metadata in SQLDelight database
 * 4. Generates identities using CryptoAdapter and Bip39Adapter
 *
 * Code Reuse:
 * - Domain model: cash.imani.identity.domain.Identity (100% reused)
 * - Encryption: AndroidIdentityManager wraps Android Keystore
 * - Persistence: SQLDelight generated queries
 * - Crypto: Platform-specific CryptoAdapter and Bip39Adapter
 */
class AndroidIdentityRepository(
    private val database: ImaniDatabase,
    private val identityManager: AndroidIdentityManager,
    private val cryptoAdapter: cash.imani.identity.crypto.CryptoAdapter,
    private val bip39Adapter: cash.imani.identity.crypto.Bip39Adapter,
) : IdentityRepository {
    private val queries = database.identityQueries

    override suspend fun createIdentity(label: String): Result<Identity> =
        withContext(Dispatchers.IO) {
            runCatching {
                // Validate label
                require(label.trim().length in 1..100) {
                    "Identity label must be 1-100 characters"
                }

                // 1. Generate keypair using crypto adapter
                val keypair = cryptoAdapter.generateKeypair()

                // 2. Generate 12-word mnemonic from private key (first 16 bytes = 128 bits)
                val mnemonic = bip39Adapter.entropyToMnemonic(keypair.privateKey.copyOfRange(0, 16))

                // 3. Create identity domain object
                val now = Clock.System.now()
                val id = UUID.randomUUID().toString()
                val identity =
                    Identity(
                        id = id,
                        label = label.trim(),
                        publicKey = keypair.publicKey.toHex(),
                        privateKey = keypair.privateKey.toHex(),
                        createdAt = now,
                        lastUsedAt = now,
                    )

                // 4. Store identity in database (encrypts private key via AndroidIdentityManager)
                saveIdentity(identity).getOrThrow()

                // 5. Store encrypted mnemonic in SharedPreferences
                storeMnemonic(id, mnemonic)

                // 6. Return the created identity
                identity
            }
        }

    /**
     * Save an existing identity to the database with encrypted private key.
     */
    suspend fun saveIdentity(identity: Identity): Result<Unit> =
        withContext(Dispatchers.IO) {
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
                    lastUsedAt = identityWithoutPrivKey.lastUsedAt?.toEpochMilliseconds(),
                )
            }
        }

    override suspend fun listIdentities(): Result<List<Identity>> =
        withContext(Dispatchers.IO) {
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
                            lastUsedAt = entity.lastUsedAt?.let { Instant.fromEpochMilliseconds(it) },
                        )
                    }
            }
        }

    override suspend fun getIdentity(id: String): Result<Identity> =
        withContext(Dispatchers.IO) {
            runCatching {
                val entity =
                    queries.selectById(id).executeAsOneOrNull()
                        ?: throw IdentityNotFoundException(id)

                Identity(
                    id = entity.id,
                    label = entity.label,
                    publicKey = entity.publicKey,
                    privateKey = identityManager.decryptPrivateKey(entity.id, entity.encryptedPrivateKey),
                    createdAt = Instant.fromEpochMilliseconds(entity.createdAt),
                    lastUsedAt = entity.lastUsedAt?.let { Instant.fromEpochMilliseconds(it) },
                )
            }
        }

    override suspend fun deleteIdentity(id: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                // 1. Delete from database
                queries.deleteById(id)

                // 2. Delete encrypted private key from Keystore
                identityManager.deletePrivateKey(id)
            }
        }

    override suspend fun importFromMnemonic(
        mnemonic: String,
        label: String,
    ): Result<Identity> =
        withContext(Dispatchers.IO) {
            runCatching {
                // NOTE: Identity import from mnemonic delegated to use cases (ImportIdentityUseCase)
                throw UnsupportedOperationException(
                    "Use ImportIdentityUseCase for mnemonic import, then call saveIdentity()",
                )
            }
        }

    override suspend fun getPrivateKey(id: String): Result<ByteArray> =
        withContext(Dispatchers.IO) {
            runCatching {
                val entity =
                    queries.selectById(id).executeAsOneOrNull()
                        ?: throw IdentityNotFoundException(id)

                // Decrypt and convert the private key hex string to bytes
                val privateKeyHex = identityManager.decryptPrivateKey(entity.id, entity.encryptedPrivateKey)
                hexStringToByteArray(privateKeyHex)
            }
        }

    /**
     * Convert a hex string to a byte array.
     */
    private fun hexStringToByteArray(hex: String): ByteArray {
        val len = hex.length
        val data = ByteArray(len / 2)
        for (i in 0 until len step 2) {
            data[i / 2] = ((Character.digit(hex[i], 16) shl 4) + Character.digit(hex[i + 1], 16)).toByte()
        }
        return data
    }

    override suspend fun importFromNsec(
        nsec: String,
        label: String,
    ): Result<Identity> =
        withContext(Dispatchers.IO) {
            runCatching {
                // NOTE: Identity import from nsec delegated to use cases (ImportIdentityUseCase)
                throw UnsupportedOperationException(
                    "Use ImportIdentityUseCase for nsec import, then call saveIdentity()",
                )
            }
        }

    override suspend fun exportMnemonic(id: String): Result<String> =
        withContext(Dispatchers.IO) {
            runCatching {
                retrieveMnemonic(id) ?: throw IdentityNotFoundException("Mnemonic not found for identity: $id")
            }
        }

    override suspend fun exportNsec(id: String): Result<String> =
        withContext(Dispatchers.IO) {
            runCatching {
                // NOTE: Nsec export delegated to use cases (ExportNsecUseCase)
                throw UnsupportedOperationException(
                    "Use ExportNsecUseCase for nsec export",
                )
            }
        }

    override suspend fun updateLastUsed(id: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val now = kotlinx.datetime.Clock.System.now().toEpochMilliseconds()
                queries.updateLastUsed(lastUsedAt = now, id = id)
            }
        }

    /**
     * Update the label of an identity (non-interface method).
     */
    suspend fun updateLabel(
        id: String,
        newLabel: String,
    ): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                require(newLabel.trim().length in 1..100) {
                    "Label must be 1-100 characters, got ${newLabel.trim().length}"
                }
                queries.updateLabel(label = newLabel.trim(), id = id)
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
                        lastUsedAt = entity.lastUsedAt?.let { Instant.fromEpochMilliseconds(it) },
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
                        lastUsedAt = it.lastUsedAt?.let { ts -> Instant.fromEpochMilliseconds(ts) },
                    )
                }
            }
    }

    /**
     * Stores an encrypted mnemonic in SharedPreferences.
     *
     * @param identityId The identity ID
     * @param mnemonic The mnemonic phrase to store
     */
    private fun storeMnemonic(
        identityId: String,
        mnemonic: String,
    ) {
        // Encrypt mnemonic using Android Keystore
        val mnemonicBytes = mnemonic.encodeToByteArray()
        val encryptedMnemonic =
            identityManager.keystoreManager.encryptPrivateKey(
                mnemonicBytes,
                "mnemonic_$identityId",
            )

        // Store in SharedPreferences
        val prefs =
            android.preference.PreferenceManager.getDefaultSharedPreferences(
                org.koin.core.context.GlobalContext.get().get<android.content.Context>(),
            )
        prefs.edit()
            .putString("encrypted_mnemonic_$identityId", encryptedMnemonic.toHex())
            .apply()
    }

    /**
     * Retrieves and decrypts a mnemonic from SharedPreferences.
     *
     * @param identityId The identity ID
     * @return The decrypted mnemonic phrase, or null if not found
     */
    private fun retrieveMnemonic(identityId: String): String? {
        val prefs =
            android.preference.PreferenceManager.getDefaultSharedPreferences(
                org.koin.core.context.GlobalContext.get().get<android.content.Context>(),
            )

        val encryptedHex = prefs.getString("encrypted_mnemonic_$identityId", null) ?: return null
        val encryptedBytes = hexStringToByteArray(encryptedHex)

        // Decrypt using Android Keystore
        val mnemonicBytes =
            identityManager.keystoreManager.decryptPrivateKey(
                encryptedBytes,
                "mnemonic_$identityId",
            )

        return mnemonicBytes.decodeToString()
    }
}

/**
 * Thrown when an identity is not found in the repository.
 */
class IdentityNotFoundException(id: String) : Exception("Identity not found: $id")
