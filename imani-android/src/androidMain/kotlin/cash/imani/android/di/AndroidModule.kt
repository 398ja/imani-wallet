package cash.imani.android.di

import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import cash.imani.android.db.ImaniDatabase
import cash.imani.android.identity.AndroidIdentityManager
import cash.imani.android.repository.AndroidIdentityRepository
import cash.imani.android.repository.AndroidVoucherRepository
import cash.imani.android.security.BiometricAuthenticator
import cash.imani.android.security.KeystoreManager
import cash.imani.identity.repository.IdentityRepository
import cash.imani.voucher.repository.VoucherRepository
import org.koin.android.ext.koin.androidContext
import org.koin.dsl.module

/**
 * Koin DI module for Android-specific dependencies.
 *
 * Provides:
 * - KeystoreManager: Android Keystore encryption for private keys
 * - BiometricAuthenticator: Fingerprint/face unlock for app access
 * - AndroidIdentityManager: Android wrapper for identity management
 * - SQLDelight database: ImaniDatabase with Android driver
 * - AndroidIdentityRepository: Identity persistence with encrypted private keys
 * - AndroidVoucherRepository: Voucher and proof persistence
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

    // Security - Biometric Authentication
    single {
        BiometricAuthenticator(
            context = androidContext()
        )
    }

    // Identity Management - Android wrapper
    single {
        AndroidIdentityManager(
            keystoreManager = get()
        )
    }

    // SQLDelight Database Driver
    single<SqlDriver> {
        AndroidSqliteDriver(
            schema = ImaniDatabase.Schema,
            context = androidContext(),
            name = "imani.db"
        )
    }

    // SQLDelight Database
    single {
        ImaniDatabase(driver = get())
    }

    // Repositories
    single<IdentityRepository> {
        AndroidIdentityRepository(
            database = get(),
            identityManager = get()
        )
    }

    single<VoucherRepository> {
        AndroidVoucherRepository(
            database = get()
        )
    }
}
