package cash.imani.app

import androidx.compose.runtime.Composable
import cash.imani.app.navigation.MainScreen
import cash.imani.app.ui.theme.ImaniTheme

/**
 * Main Imani Wallet application composable.
 *
 * Sets up theme and navigation for the marketplace app.
 *
 * Architecture:
 * - Phase 0-1 (Complete): Identity module, Koin DI
 * - Phase 1 (Current): Bottom tab navigation (Shop, Merchant, Settings)
 * - Phase 2: Shop tab customer features
 * - Phase 3: Merchant tab business features
 * - Phase 4-5: Enhanced features and polish
 *
 * Navigation:
 * - MainScreen: Three-tab marketplace navigation
 * - Shop: Customer features (browse, purchase, redeem)
 * - Merchant: Business features (sales, offers, POS)
 * - Settings: Account management (identity, payment, backup)
 *
 * See: project/web-marketplace-ui-implementation.md
 */
@Composable
fun ImaniApp() {
    ImaniTheme {
        MainScreen()
    }
}
