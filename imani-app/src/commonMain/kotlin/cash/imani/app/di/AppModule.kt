package cash.imani.app.di

import cash.imani.app.ui.identity.IdentityViewModel
import cash.imani.app.ui.voucher.VoucherViewModel
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
import cash.imani.voucher.adapter.VoucherAdapter
import cash.imani.voucher.adapter.createVoucherAdapter
import cash.imani.voucher.network.MintApiClient
import cash.imani.voucher.network.createHttpClient
import cash.imani.voucher.repository.ProofRepository
import cash.imani.voucher.repository.VoucherRepository
import cash.imani.voucher.repository.createProofRepository
import cash.imani.voucher.repository.createVoucherRepository
import cash.imani.voucher.nostr.NostrConfig
import cash.imani.voucher.nostr.NostrVoucherClient
import cash.imani.voucher.nostr.createNostrVoucherClient
import cash.imani.voucher.usecases.CheckInvoicePaidUseCase
import cash.imani.voucher.usecases.CreateLightningInvoiceUseCase
import cash.imani.voucher.usecases.CreateOfferUseCase
import cash.imani.voucher.usecases.DiscoverMerchantOffersUseCase
import cash.imani.voucher.usecases.GetSalesMetricsUseCase
import cash.imani.voucher.usecases.IssueVoucherUseCase
import cash.imani.voucher.usecases.PublishOfferToNostrUseCase
import cash.imani.voucher.usecases.RedeemVoucherUseCase
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
 * - Voucher repositories (proof and voucher)
 * - Voucher adapters (platform-specific: WebVoucherAdapter for JS, JvmVoucherAdapter for JVM)
 * - Voucher use cases (issue, redeem, Lightning invoice generation/checking)
 * - Voucher ViewModel
 *
 * Phase 1: Identity module complete
 * Phase 2: Voucher module added (including Lightning integration - NUT-04)
 * Task 2.2.5: Offer management use cases (Create, Publish, Discover)
 * Task 2.3.2: VoucherAdapter added with platform-specific implementations
 * Phase 3+: Split into feature modules
 */
val appModule =
    module {
        // Crypto adapters - platform-specific implementations
        single<CryptoAdapter> { createCryptoAdapter() }
        single<Bip39Adapter> { createBip39Adapter() }

        // Repositories - Identity
        single<IdentityRepository> { createIdentityRepository(get(), get()) }

        // Repositories - Voucher
        single<ProofRepository> { createProofRepository() }
        single<VoucherRepository> { createVoucherRepository() }

        // Nostr - Voucher and Offer Storage
        single<NostrVoucherClient> { createNostrVoucherClient(NostrConfig.DEFAULT_RELAYS) }

        // Adapters - Voucher (Task 2.3.2, updated in Tasks 2.4.1 and 2.4.2)
        single<VoucherAdapter> {
            createVoucherAdapter(
                voucherRepository = get(),
                proofRepository = get(),
                mintApiClient = get(),
                identityRepository = get(),
                nostrClient = get(),
                cryptoAdapter = get(),
            )
        }

        // HTTP Client
        single { createHttpClient() }

        // Mint API Client
        single { MintApiClient(get(), get()) }

        // Use Cases - Identity
        single { CreateIdentityUseCase(get()) }
        single { ListIdentitiesUseCase(get()) }
        single { ImportIdentityUseCase(get()) }
        single { ImportIdentityFromNsecUseCase(get()) }

        // Use Cases - Voucher (Task 2.4.1: Refactored to use adapter)
        single {
            IssueVoucherUseCase(
                voucherAdapter = get(),
            )
        }
        single {
            RedeemVoucherUseCase(
                voucherAdapter = get(),
            )
        }
        single {
            CreateLightningInvoiceUseCase(
                mintApiClient = get(),
            )
        }
        single {
            CheckInvoicePaidUseCase(
                mintApiClient = get(),
            )
        }

        // Use Cases - Offer Management (Task 2.2.5)
        single {
            CreateOfferUseCase()
        }
        single {
            PublishOfferToNostrUseCase(
                identityRepository = get(),
                cryptoAdapter = get(),
                nostrClient = get(),
            )
        }
        single {
            DiscoverMerchantOffersUseCase(
                nostrClient = get(),
            )
        }
        single {
            GetSalesMetricsUseCase(
                voucherRepository = get(),
            )
        }

        // ViewModels - use factory() instead of single() to create new instances
        // per activity. This ensures ViewModel state is reset when the activity recreates.
        factory {
            IdentityViewModel(
                createIdentityUseCase = get(),
                listIdentitiesUseCase = get(),
                importIdentityUseCase = get(),
                importIdentityFromNsecUseCase = get(),
            )
        }

        factory {
            VoucherViewModel(
                voucherRepository = get(),
                issueVoucherUseCase = get(),
                redeemVoucherUseCase = get(),
            )
        }
    }
