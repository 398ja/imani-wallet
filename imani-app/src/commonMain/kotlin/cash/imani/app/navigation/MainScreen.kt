package cash.imani.app.navigation

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import cash.imani.app.ui.merchant.MerchantTabScreen
import cash.imani.app.ui.settings.SettingsTabScreen
import cash.imani.app.ui.shop.ShopTabScreen

/**
 * Main application screen with bottom tab navigation.
 *
 * Implements the three-tab marketplace navigation:
 * - Shop: Customer features (browse, purchase, redeem)
 * - Merchant: Business features (sales, offers, POS)
 * - Settings: Account management (identity, payment, backup)
 *
 * Navigation structure:
 * - Mobile (<640px): Bottom navigation bar
 * - Tablet/Desktop (>640px): Side navigation rail (TODO: Task 1.1 responsive enhancement)
 *
 * Tab state is preserved using rememberSaveable to survive configuration changes.
 *
 * See: project/web-marketplace-ui-implementation.md Phase 1, Task 1.1
 */
@Composable
fun MainScreen() {
    // Preserve tab selection across configuration changes
    var selectedTab by rememberSaveable { mutableStateOf(AppTab.SHOP) }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        bottomBar = {
            BottomNavigation(
                selectedTab = selectedTab,
                onTabSelected = { tab ->
                    selectedTab = tab
                },
            )
        },
    ) { padding ->
        // Content area - display selected tab screen
        when (selectedTab) {
            AppTab.SHOP -> ShopTabScreen(Modifier.padding(padding))
            AppTab.MERCHANT -> MerchantTabScreen(Modifier.padding(padding))
            AppTab.SETTINGS -> SettingsTabScreen(Modifier.padding(padding))
        }
    }
}
