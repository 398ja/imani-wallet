package cash.imani.app

import androidx.compose.runtime.Composable
import cash.imani.app.navigation.IdentityNavHost
import cash.imani.app.ui.identity.IdentityViewModel
import cash.imani.app.ui.theme.ImaniTheme
import cash.imani.identity.crypto.createBip39Adapter
import cash.imani.identity.crypto.createCryptoAdapter
import cash.imani.identity.repository.createIdentityRepository
import cash.imani.identity.usecases.CreateIdentityUseCase
import cash.imani.identity.usecases.ImportIdentityFromNsecUseCase
import cash.imani.identity.usecases.ImportIdentityUseCase
import cash.imani.identity.usecases.ListIdentitiesUseCase

/**
 * Main Imani Wallet application composable.
 *
 * Sets up theme, dependencies, and navigation.
 *
 * Phase 1: Manual dependency injection
 * Phase 2: Will migrate to Koin (Task 1.5)
 */
@Composable
fun ImaniApp() {
    // Manual DI setup (temporary - will be replaced with Koin in Task 1.5)
    val cryptoAdapter = createCryptoAdapter()
    val bip39Adapter = createBip39Adapter()
    val identityRepository = createIdentityRepository(cryptoAdapter, bip39Adapter)

    val createIdentityUseCase = CreateIdentityUseCase(identityRepository)
    val listIdentitiesUseCase = ListIdentitiesUseCase(identityRepository)
    val importIdentityUseCase = ImportIdentityUseCase(identityRepository)
    val importIdentityFromNsecUseCase = ImportIdentityFromNsecUseCase(identityRepository)

    val identityViewModel =
        IdentityViewModel(
            createIdentityUseCase = createIdentityUseCase,
            listIdentitiesUseCase = listIdentitiesUseCase,
            importIdentityUseCase = importIdentityUseCase,
            importIdentityFromNsecUseCase = importIdentityFromNsecUseCase,
        )

    ImaniTheme {
        IdentityNavHost(viewModel = identityViewModel)
    }
}
