package cash.imani.identity.repository

import cash.imani.identity.crypto.Bip39Adapter
import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.domain.Identity
import cash.imani.identity.util.toHex
import kotlinx.datetime.Clock
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * JVM implementation of IdentityRepository using in-memory storage.
 *
 * Phase 0/1 Status: In-memory storage for testing purposes only.
 * Phase 2+: Replace with proper database (Room, H2, etc.)
 */
class JvmIdentityRepository(
    private val cryptoAdapter: CryptoAdapter,
    private val bip39Adapter: Bip39Adapter,
) : IdentityRepository {
    private val identities = ConcurrentHashMap<String, Identity>()
    private val privateKeys = ConcurrentHashMap<String, ByteArray>()
    private val mnemonics = ConcurrentHashMap<String, String>()

    override suspend fun createIdentity(label: String): Result<Identity> =
        runCatching {
            require(label.trim().length in 1..100) {
                "Identity label must be 1-100 characters"
            }

            val keypair = cryptoAdapter.generateKeypair()
            val mnemonic = bip39Adapter.entropyToMnemonic(keypair.privateKey.copyOfRange(0, 16))

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

            identities[id] = identity
            privateKeys[id] = keypair.privateKey
            mnemonics[id] = mnemonic

            identity
        }

    override suspend fun listIdentities(): Result<List<Identity>> =
        runCatching {
            identities.values.sortedByDescending { it.lastUsedAt }
        }

    override suspend fun getIdentity(id: String): Result<Identity> =
        runCatching {
            identities[id] ?: throw IdentityNotFoundException(id)
        }

    override suspend fun getPrivateKey(id: String): Result<ByteArray> =
        runCatching {
            privateKeys[id] ?: throw IdentityNotFoundException(id)
        }

    override suspend fun deleteIdentity(id: String): Result<Unit> =
        runCatching {
            if (!identities.containsKey(id)) {
                throw IdentityNotFoundException(id)
            }
            identities.remove(id)
            privateKeys.remove(id)
            mnemonics.remove(id)
        }

    override suspend fun importFromMnemonic(
        mnemonic: String,
        label: String,
    ): Result<Identity> =
        runCatching {
            if (!bip39Adapter.validateMnemonic(mnemonic)) {
                throw InvalidMnemonicException("Invalid mnemonic phrase")
            }

            require(label.trim().length in 1..100) {
                "Identity label must be 1-100 characters"
            }

            val seed = bip39Adapter.mnemonicToSeed(mnemonic)
            val privateKey = bip39Adapter.derivePrivateKey(seed)
            val publicKeyBytes = cryptoAdapter.generateKeypair().publicKey

            val now = Clock.System.now()
            val id = UUID.randomUUID().toString()
            val identity =
                Identity(
                    id = id,
                    label = label.trim(),
                    publicKey = publicKeyBytes.toHex(),
                    privateKey = privateKey.toHex(),
                    createdAt = now,
                    lastUsedAt = now,
                )

            identities[id] = identity
            privateKeys[id] = privateKey
            mnemonics[id] = mnemonic

            identity
        }

    override suspend fun importFromNsec(
        nsec: String,
        label: String,
    ): Result<Identity> =
        runCatching {
            require(label.trim().isNotEmpty()) { "Label cannot be empty" }

            // Decode nsec to get private key
            val privateKey = cash.imani.identity.util.Bech32.decodeNsec(nsec)

            // Derive public key from private key
            val publicKeyBytes = cryptoAdapter.getPublicKey(privateKey)

            // Create identity
            val now = Clock.System.now()
            val id = UUID.randomUUID().toString()
            val identity =
                Identity(
                    id = id,
                    label = label.trim(),
                    publicKey = publicKeyBytes.toHex(),
                    privateKey = privateKey.toHex(),
                    createdAt = now,
                    lastUsedAt = now,
                )

            identities[id] = identity
            privateKeys[id] = privateKey
            // No mnemonic for nsec imports
            mnemonics.remove(id)

            identity
        }

    override suspend fun exportMnemonic(id: String): Result<String> =
        runCatching {
            mnemonics[id] ?: throw IdentityNotFoundException(id)
        }

    override suspend fun exportNsec(id: String): Result<String> =
        runCatching {
            val privateKey = privateKeys[id] ?: throw IdentityNotFoundException(id)
            cash.imani.identity.util.Bech32.encodeNsec(privateKey)
        }

    override suspend fun updateLastUsed(id: String): Result<Unit> =
        runCatching {
            val identity = identities[id] ?: throw IdentityNotFoundException(id)
            identities[id] = identity.copy(lastUsedAt = Clock.System.now())
        }
}

/**
 * JVM platform implementation - returns JvmIdentityRepository.
 */
actual fun createIdentityRepository(
    cryptoAdapter: CryptoAdapter,
    bip39Adapter: Bip39Adapter,
): IdentityRepository = JvmIdentityRepository(cryptoAdapter, bip39Adapter)
