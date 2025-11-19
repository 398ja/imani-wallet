package cash.imani.android.di

import cash.imani.android.identity.AndroidIdentityManager
import cash.imani.android.security.KeystoreManager
import org.koin.dsl.module

/**
 * Koin DI module for Android-specific dependencies.
 *
 * Provides:
 * - KeystoreManager: Android Keystore encryption for private keys
 * - AndroidIdentityManager: Android wrapper for identity management
 *
 * Future additions (Phase 4.2.2):
 * - SQLDelight database drivers
 * - Android-specific repositories
 *
 * Usage:
 * ```kotlin
 * startKoin {
 *     androidContext(this@ImaniApplication)
 *     modules(
 *         appModule,      // From imani-app (shared)
 *         androidModule   // Android-specific
 *     )
 * }
 * ```
 */
val androidModule = module {

    // Security - Android Keystore
    single { KeystoreManager() }

    // Identity Management - Android wrapper
    single {
        AndroidIdentityManager(
            keystoreManager = get()
        )
    }

    // TODO Phase 4.2.2: Add SQLDelight database
    // single<SqlDriver> {
    //     AndroidSqliteDriver(
    //         IdentityDatabase.Schema,
    //         androidContext(),
    //         "identity.db"
    //     )
    // }

    // TODO Phase 4.2.2: Add Android repositories
    // single<IdentityRepository> {
    //     AndroidIdentityRepository(
    //         database = get(),
    //         identityManager = get()
    //     )
    // }
}
