package cash.imani.identity.repository

import cash.imani.identity.crypto.Bip39Adapter
import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.domain.Identity
import cash.imani.identity.util.toHex
import kotlinx.datetime.Clock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.w3c.dom.Storage
import org.w3c.dom.get
import org.w3c.dom.set
import kotlin.random.Random

/**
 * Web implementation of IdentityRepository using browser localStorage.
 *
 * Storage Strategy:
 * - Identity metadata: `identity_{id}` → JSON-serialized Identity
 * - Private keys: `privkey_{id}` → Hex-encoded encrypted private key
 * - Mnemonics: `mnemonic_{id}` → Encrypted mnemonic phrase
 *
 * Encryption:
 * - Phase 1: Simple XOR with derived key (NOT production-ready)
 * - Phase 2: AES-GCM with user passphrase + PBKDF2
 * - Phase 3: Add biometric authentication option
 *
 * Security Notes:
 * - localStorage is vulnerable to XSS attacks
 * - Content Security Policy should be enforced
 * - Consider IndexedDB for Phase 2 (larger storage, better performance)
 */
class WebIdentityRepository(
    private val cryptoAdapter: CryptoAdapter,
    private val bip39Adapter: Bip39Adapter,
    private val storage: Storage = kotlinx.browser.window.localStorage,
) : IdentityRepository {
    private val json =
        Json {
            ignoreUnknownKeys = true
            prettyPrint = false
        }

    // Phase 1: Simple derived key for encryption (NOT secure - replace in Phase 2)
    // TODO Phase 2: Derive from user passphrase using PBKDF2
    private val encryptionKey = "imani-wallet-phase1-key-DO-NOT-USE-IN-PRODUCTION"

    override suspend fun createIdentity(label: String): Result<Identity> =
        runCatching {
            // Validate label
            require(label.trim().length in 1..100) {
                "Identity label must be 1-100 characters"
            }

            // Generate keypair
            val keypair = cryptoAdapter.generateKeypair()

            // Generate 12-word mnemonic from private key
            val mnemonic = bip39Adapter.entropyToMnemonic(keypair.privateKey.copyOfRange(0, 16))

            // Create identity
            val now = Clock.System.now()
            val id = generateUuid()
            val identity =
                Identity(
                    id = id,
                    label = label.trim(),
                    publicKey = keypair.publicKey.toHex(),
                    privateKey = keypair.privateKey.toHex(),
                    createdAt = now,
                    lastUsedAt = now,
                )

            // Store identity metadata (without private key in JSON)
            val identityJson = json.encodeToString(identity)
            storage["identity_$id"] = identityJson

            // Store encrypted private key
            val encryptedPrivKey = encryptData(keypair.privateKey)
            storage["privkey_$id"] = encryptedPrivKey

            // Store encrypted mnemonic
            val encryptedMnemonic = encryptData(mnemonic.toByteArray())
            storage["mnemonic_$id"] = encryptedMnemonic

            identity
        }

    override suspend fun listIdentities(): Result<List<Identity>> =
        runCatching {
            val identities = mutableListOf<Identity>()

            // Iterate through localStorage keys
            for (i in 0 until storage.length) {
                val key = storage.key(i) ?: continue
                if (key.startsWith("identity_")) {
                    val identityJson = storage[key] ?: continue
                    try {
                        val identity = json.decodeFromString<Identity>(identityJson)
                        identities.add(identity)
                    } catch (e: Exception) {
                        // Skip malformed entries
                        console.error("Failed to parse identity: $key", e)
                    }
                }
            }

            // Sort by lastUsedAt descending (most recent first)
            identities.sortedByDescending { it.lastUsedAt }
        }

    override suspend fun getIdentity(id: String): Result<Identity> =
        runCatching {
            val identityJson =
                storage["identity_$id"]
                    ?: throw IdentityNotFoundException(id)

            json.decodeFromString<Identity>(identityJson)
        }

    override suspend fun getPrivateKey(id: String): Result<ByteArray> =
        runCatching {
            val encryptedPrivKey =
                storage["privkey_$id"]
                    ?: throw IdentityNotFoundException(id)

            decryptData(encryptedPrivKey)
        }

    override suspend fun deleteIdentity(id: String): Result<Unit> =
        runCatching {
            // Check if identity exists
            if (storage["identity_$id"] == null) {
                throw IdentityNotFoundException(id)
            }

            // Remove all associated data
            storage.removeItem("identity_$id")
            storage.removeItem("privkey_$id")
            storage.removeItem("mnemonic_$id")
        }

    override suspend fun importFromMnemonic(
        mnemonic: String,
        label: String,
    ): Result<Identity> =
        runCatching {
            // Validate mnemonic
            if (!bip39Adapter.validateMnemonic(mnemonic)) {
                throw InvalidMnemonicException("Invalid mnemonic phrase")
            }

            // Validate label
            require(label.trim().length in 1..100) {
                "Identity label must be 1-100 characters"
            }

            // Derive seed from mnemonic
            val seed = bip39Adapter.mnemonicToSeed(mnemonic)

            // Derive private key using Nostr path
            val privateKey = bip39Adapter.derivePrivateKey(seed)

            // Derive public key from private key
            val publicKeyBytes = cryptoAdapter.generateKeypair().publicKey // TODO: Proper derivation

            // Create identity
            val now = Clock.System.now()
            val id = generateUuid()
            val identity =
                Identity(
                    id = id,
                    label = label.trim(),
                    publicKey = publicKeyBytes.toHex(),
                    privateKey = privateKey.toHex(),
                    createdAt = now,
                    lastUsedAt = now,
                )

            // Store identity
            val identityJson = json.encodeToString(identity)
            storage["identity_$id"] = identityJson

            // Store encrypted private key
            val encryptedPrivKey = encryptData(privateKey)
            storage["privkey_$id"] = encryptedPrivKey

            // Store encrypted mnemonic
            val encryptedMnemonic = encryptData(mnemonic.toByteArray())
            storage["mnemonic_$id"] = encryptedMnemonic

            identity
        }

    override suspend fun exportMnemonic(id: String): Result<String> =
        runCatching {
            val encryptedMnemonic =
                storage["mnemonic_$id"]
                    ?: throw IdentityNotFoundException(id)

            val mnemonicBytes = decryptData(encryptedMnemonic)
            mnemonicBytes.decodeToString()
        }

    override suspend fun updateLastUsed(id: String): Result<Unit> =
        runCatching {
            val identityJson =
                storage["identity_$id"]
                    ?: throw IdentityNotFoundException(id)

            val identity = json.decodeFromString<Identity>(identityJson)
            val updated = identity.copy(lastUsedAt = Clock.System.now())

            storage["identity_$id"] = json.encodeToString(updated)
        }

    /**
     * Encrypts data using simple XOR with derived key.
     *
     * Phase 1: NOT cryptographically secure - for MVP only
     * Phase 2: Replace with AES-GCM + PBKDF2
     *
     * @param data Plaintext bytes
     * @return Hex-encoded encrypted data
     */
    private suspend fun encryptData(data: ByteArray): String {
        // TODO Phase 2: Implement proper AES-GCM encryption
        // For Phase 1, use simple XOR (NOT SECURE)
        val keyBytes = cryptoAdapter.sha256(encryptionKey.toByteArray())
        val encrypted =
            ByteArray(data.size) { i ->
                (data[i].toInt() xor keyBytes[i % keyBytes.size].toInt()).toByte()
            }
        return encrypted.toHex()
    }

    /**
     * Decrypts data encrypted with encryptData.
     *
     * @param encryptedHex Hex-encoded encrypted data
     * @return Plaintext bytes
     */
    private suspend fun decryptData(encryptedHex: String): ByteArray {
        // TODO Phase 2: Implement proper AES-GCM decryption
        // For Phase 1, XOR decryption (symmetric with encryption)
        val encrypted = encryptedHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val keyBytes = cryptoAdapter.sha256(encryptionKey.toByteArray())
        return ByteArray(encrypted.size) { i ->
            (encrypted[i].toInt() xor keyBytes[i % keyBytes.size].toInt()).toByte()
        }
    }

    /**
     * Generates a UUID v4 for identity IDs.
     */
    private fun generateUuid(): String {
        // Simple UUID v4 generation
        val random = Random.Default
        val bytes = ByteArray(16)
        random.nextBytes(bytes)

        // Set version to 4
        bytes[6] = ((bytes[6].toInt() and 0x0F) or 0x40).toByte()
        // Set variant to 10
        bytes[8] = ((bytes[8].toInt() and 0x3F) or 0x80).toByte()

        return bytes.toHex().chunked(2).joinToString("") { it }
            .let {
                "${it.substring(
                    0,
                    8,
                )}-${it.substring(8, 12)}-${it.substring(12, 16)}-${it.substring(16, 20)}-${it.substring(20, 32)}"
            }
    }
}
