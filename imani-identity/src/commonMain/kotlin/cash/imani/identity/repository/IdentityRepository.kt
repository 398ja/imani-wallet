package cash.imani.identity.repository

import cash.imani.identity.domain.Identity

/**
 * Repository interface for identity persistence and management.
 *
 * Provides CRUD operations for Nostr identities with secure key storage:
 * - **Create**: Generate new identity with mnemonic backup
 * - **Import**: Restore identity from BIP39 mnemonic phrase
 * - **List**: Retrieve all stored identities
 * - **Get**: Fetch specific identity by ID
 * - **Delete**: Remove identity and associated keys
 * - **Export**: Retrieve mnemonic for backup
 *
 * Implementation Strategy:
 * - **Web (jsMain)**: localStorage with AES-GCM encrypted private keys
 * - **Android (androidMain)**: Room database with Android Keystore
 * - **iOS (iosMain)**: Core Data with iOS Keychain
 *
 * Security Notes:
 * - Private keys MUST be encrypted at rest
 * - Mnemonics SHOULD be encrypted with user passphrase (Phase 2)
 * - Consider biometric authentication for key access (Phase 3)
 */
interface IdentityRepository {
    /**
     * Creates a new identity with a randomly generated keypair.
     *
     * Generates:
     * - 32-byte secp256k1 keypair
     * - 12-word BIP39 mnemonic for backup
     * - Unique identity ID (UUID)
     *
     * Stores:
     * - Identity metadata (ID, label, public key, timestamps)
     * - Encrypted private key
     * - Encrypted mnemonic phrase
     *
     * @param label User-friendly label for the identity (1-100 characters)
     * @return Result containing the created Identity or error
     */
    suspend fun createIdentity(label: String): Result<Identity>

    /**
     * Lists all stored identities.
     *
     * Returns identities sorted by lastUsedAt descending (most recent first).
     * Only includes metadata; private keys are NOT included in results.
     *
     * @return Result containing list of identities or error
     */
    suspend fun listIdentities(): Result<List<Identity>>

    /**
     * Retrieves a specific identity by ID.
     *
     * @param id Unique identity identifier (UUID)
     * @return Result containing the Identity or error if not found
     */
    suspend fun getIdentity(id: String): Result<Identity>

    /**
     * Retrieves the decrypted private key for an identity.
     *
     * Security: This method decrypts the stored private key.
     * Private keys should be held in memory for minimal duration.
     *
     * @param id Unique identity identifier
     * @return Result containing the 32-byte private key or error
     */
    suspend fun getPrivateKey(id: String): Result<ByteArray>

    /**
     * Deletes an identity and all associated data.
     *
     * Removes:
     * - Identity metadata
     * - Encrypted private key
     * - Encrypted mnemonic
     *
     * WARNING: This operation is irreversible unless the user has backed up
     * their mnemonic phrase.
     *
     * @param id Unique identity identifier
     * @return Result indicating success or error
     */
    suspend fun deleteIdentity(id: String): Result<Unit>

    /**
     * Imports an identity from a BIP39 mnemonic phrase.
     *
     * Derives secp256k1 keypair from mnemonic using BIP32/BIP44 derivation.
     * Path: m/44'/1237'/0'/0/0 (Nostr standard, NIP-06)
     *
     * @param mnemonic 12 or 24-word BIP39 mnemonic phrase
     * @param label User-friendly label for the identity
     * @return Result containing the imported Identity or error
     */
    suspend fun importFromMnemonic(
        mnemonic: String,
        label: String,
    ): Result<Identity>

    /**
     * Imports an identity from an nsec (Nostr private key).
     *
     * Decodes the bech32-encoded nsec string to extract the private key,
     * derives the public key using secp256k1, and stores the identity.
     *
     * Note: No mnemonic is generated for nsec imports, as the nsec itself
     * serves as the backup/recovery mechanism.
     *
     * @param nsec Bech32-encoded private key (nsec1...)
     * @param label User-friendly label for the identity
     * @return Result containing the imported Identity or error
     */
    suspend fun importFromNsec(
        nsec: String,
        label: String,
    ): Result<Identity>

    /**
     * Exports the mnemonic phrase for an identity.
     *
     * Security: Returns decrypted mnemonic. Should be displayed to user
     * with appropriate warnings about secure storage.
     *
     * @param id Unique identity identifier
     * @return Result containing the BIP39 mnemonic phrase or error
     */
    suspend fun exportMnemonic(id: String): Result<String>

    /**
     * Exports the nsec (Nostr private key) for an identity.
     *
     * Security: Returns the private key encoded in bech32 nsec format.
     * Should be displayed to user with appropriate warnings about secure storage.
     *
     * @param id Unique identity identifier
     * @return Result containing the nsec1... encoded private key or error
     */
    suspend fun exportNsec(id: String): Result<String>

    /**
     * Updates the lastUsedAt timestamp for an identity.
     *
     * Called after signing operations to track identity activity.
     *
     * @param id Unique identity identifier
     * @return Result indicating success or error
     */
    suspend fun updateLastUsed(id: String): Result<Unit>
}

/**
 * Exception thrown when an identity is not found.
 */
class IdentityNotFoundException(id: String) : Exception("Identity not found: $id")

/**
 * Exception thrown when mnemonic import fails.
 */
class InvalidMnemonicException(message: String) : Exception(message)

/**
 * Exception thrown when storage operations fail.
 */
class IdentityStorageException(message: String, cause: Throwable? = null) : Exception(message, cause)
