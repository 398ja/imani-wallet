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
val androidModule =
    module {

        // Security - Android Keystore
        single { KeystoreManager() }

        // Security - Biometric Authentication
        single {
            BiometricAuthenticator(
                context = androidContext(),
            )
        }

        // Identity Management - Android wrapper
        single {
            AndroidIdentityManager(
                keystoreManager = get(),
            )
        }

        // SQLDelight Database Driver
        single<SqlDriver> {
            AndroidSqliteDriver(
                schema = ImaniDatabase.Schema,
                context = androidContext(),
                name = "imani.db",
            )
        }

        // SQLDelight Database
        single {
            ImaniDatabase(driver = get())
        }

        // Repositories
        single<IdentityRepository> {
            AndroidIdentityRepository(
                context = androidContext(),
                database = get(),
                identityManager = get(),
                cryptoAdapter = get(),
                bip39Adapter = get(),
            )
        }

        single<VoucherRepository> {
            AndroidVoucherRepository(
                database = get(),
            )
        }

        // TODO: VoucherService Integration (Task 2.2.3)
        //
        // To fully integrate cashu-client VoucherService with JvmVoucherAdapter:
        //
        // 1. Implement required Android adapters:
        //    - AndroidWalletStorage: WalletStorage adapter backed by SQLDelight
        //    - AndroidEncryptionService: EncryptionService using Android Keystore
        //    - AndroidIdentityKeyService: IdentityKeyService wrapping AndroidIdentityManager
        //
        // 2. Add cashu-client services to DI:
        //    single<SendService> {
        //        SendServiceImpl(
        //            walletStorage = get(),
        //            mintApiClient = get(),
        //            tokenCodec = get()
        //        )
        //    }
        //
        //    single<TokenCodec> {
        //        TokenCodecImpl() // From cashu-client
        //    }
        //
        //    single<VoucherBackupService> {
        //        VoucherBackupServiceImpl(
        //            nostrGateway = get(),
        //            encryptionService = get()
        //        )
        //    }
        //
        // 3. Wire up VoucherService:
        //    single<VoucherService> {
        //        VoucherServiceImpl(
        //            walletStorage = get(),
        //            encryptionService = get(),
        //            backupService = get(),
        //            identityKeyService = get(),
        //            sendService = get(),
        //            tokenCodec = get()
        //        ).apply {
        //            init(WalletConfig(
        //                defaultMintUrl = "http://localhost:7777",
        //                defaultUnit = "sat"
        //            ))
        //        }
        //    }
        //
        // 4. Create JvmVoucherAdapter:
        //    single<VoucherAdapter> {
        //        JvmVoucherAdapter(voucherService = get())
        //    }
        //
        // 5. Update use cases to use VoucherAdapter instead of repositories
        //
        // For now, AndroidVoucherRepository provides basic functionality.
        // Full cashu-client integration requires significant adapter work.
    }
