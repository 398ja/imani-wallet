package cash.imani.android.adapter

import cash.imani.android.db.ImaniDatabase
import xyz.tcheeric.wallet.core.security.EncryptionMetadataRepository
import xyz.tcheeric.wallet.core.security.EncryptionService
import java.lang.reflect.Field

/**
 * Creates an EncryptionService instance configured for Android.
 *
 * Uses reflection to inject AndroidEncryptionMetadataRepository into the
 * cashu-client EncryptionService, maintaining full compatibility with the
 * Java implementation while using Android-specific storage (SQLDelight).
 *
 * **Why Reflection?**: EncryptionService's constructor is no-arg and sets
 * the repository internally. We need to override it with our Android repository
 * after instantiation.
 *
 * **Thread Safety**: The returned EncryptionService instance is thread-safe
 * (all operations synchronized).
 *
 * @param database SQLDelight database instance
 * @return EncryptionService configured with AndroidEncryptionMetadataRepository
 *
 * @see xyz.tcheeric.wallet.core.security.EncryptionService
 * @see AndroidEncryptionMetadataRepository
 */
fun createAndroidEncryptionService(database: ImaniDatabase): EncryptionService {
    val service = EncryptionService()
    val androidRepo = AndroidEncryptionMetadataRepository(database)

    // Use reflection to inject our Android repository
    injectRepository(service, androidRepo)

    // Load metadata from Android storage
    service.load()

    return service
}

/**
 * Injects AndroidEncryptionMetadataRepository into EncryptionService via reflection.
 *
 * **Implementation Note**: EncryptionService has a private field `repo` of type
 * EncryptionMetadataRepository. We override it with our Android implementation.
 *
 * @param service EncryptionService instance
 * @param repository AndroidEncryptionMetadataRepository instance
 */
private fun injectRepository(
    service: EncryptionService,
    repository: EncryptionMetadataRepository,
) {
    try {
        val repoField: Field =
            EncryptionService::class.java.getDeclaredField("repo")
        repoField.isAccessible = true
        repoField.set(service, repository)
    } catch (e: Exception) {
        throw IllegalStateException(
            "Failed to inject AndroidEncryptionMetadataRepository into EncryptionService. " +
                "Reason: ${e.javaClass.simpleName} - ${e.message}. " +
                "Suggestion: Verify cashu-client EncryptionService structure matches expected design.",
            e,
        )
    }
}

/**
 * Extension function to check if encryption is initialized.
 *
 * Convenient wrapper for checking encryption status without exceptions.
 *
 * @return true if encryption is initialized and enabled, false otherwise
 */
fun EncryptionService.isInitialized(): Boolean = isEnabled
