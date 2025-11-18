package cash.imani.app

import androidx.compose.runtime.Composable
import cash.imani.app.di.koinInject
import cash.imani.app.navigation.IdentityNavHost
import cash.imani.app.ui.identity.IdentityViewModel
import cash.imani.app.ui.theme.ImaniTheme

/**
 * Main Imani Wallet application composable.
 *
 * Sets up theme, dependencies, and navigation.
 *
 * Phase 1: Uses Koin for dependency injection (Task 1.5)
 * Phase 2+: Will expand with more features (vouchers, relays, etc.)
 */
@Composable
fun ImaniApp() {
    // Koin dependency injection - ViewModel is created as singleton in appModule
    val identityViewModel: IdentityViewModel = koinInject()

    ImaniTheme {
        IdentityNavHost(viewModel = identityViewModel)
    }
}
