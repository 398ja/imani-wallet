package cash.imani.app.di

import cash.imani.app.ui.identity.IdentityViewModel
import cash.imani.identity.crypto.Bip39Adapter
import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.crypto.createBip39Adapter
import cash.imani.identity.crypto.createCryptoAdapter
import cash.imani.identity.repository.IdentityRepository
import cash.imani.identity.repository.createIdentityRepository
import cash.imani.identity.usecases.CreateIdentityUseCase
import cash.imani.identity.usecases.ImportIdentityFromNsecUseCase
import cash.imani.identity.usecases.ImportIdentityUseCase
import cash.imani.identity.usecases.ListIdentitiesUseCase
import org.koin.dsl.module

/**
 * Koin dependency injection module for Imani Wallet.
 *
 * Provides:
 * - Crypto adapters (platform-specific via factory functions)
 * - BIP39 adapter (platform-specific via factory functions)
 * - Identity repository (platform-specific via factory functions)
 * - Identity use cases
 * - Identity ViewModel
 *
 * Phase 1: Single module for simplicity
 * Phase 2+: Split into feature modules (identity, voucher, etc.)
 */
val appModule = module {
    // Crypto adapters - platform-specific implementations
    single<CryptoAdapter> { createCryptoAdapter() }
    single<Bip39Adapter> { createBip39Adapter() }

    // Repositories
    single<IdentityRepository> { createIdentityRepository(get(), get()) }

    // Use Cases
    single { CreateIdentityUseCase(get()) }
    single { ListIdentitiesUseCase(get()) }
    single { ImportIdentityUseCase(get()) }
    single { ImportIdentityFromNsecUseCase(get()) }

    // ViewModels
    single {
        IdentityViewModel(
            createIdentityUseCase = get(),
            listIdentitiesUseCase = get(),
            importIdentityUseCase = get(),
            importIdentityFromNsecUseCase = get(),
        )
    }
}
