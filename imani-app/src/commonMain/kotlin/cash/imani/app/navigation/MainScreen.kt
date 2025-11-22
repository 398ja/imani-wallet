package cash.imani.app.navigation

import androidx.compose.foundation.layout.Row
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
import cash.imani.app.ui.theme.LocalResponsiveConfig
import cash.imani.app.ui.theme.ResponsiveProvider

/**
 * Main application screen with responsive navigation.
 *
 * Implements the three-tab marketplace navigation:
 * - Shop: Customer features (browse, purchase, redeem)
 * - Merchant: Business features (sales, offers, POS)
 * - Settings: Account management (identity, payment, backup)
 *
 * Navigation structure:
 * - Mobile (<640px): Bottom navigation bar
 * - Tablet/Desktop (>640px): Side navigation rail
 *
 * Tab state is preserved using rememberSaveable to survive configuration changes.
 *
 * Phase 4.4: Responsive Design Refinement
 * See: project/web-marketplace-ui-implementation.md Phase 4, Task 4.4
 */
@Composable
fun MainScreen() {
    ResponsiveProvider {
        MainScreenContent()
    }
}

@Composable
private fun MainScreenContent() {
    // Preserve tab selection across configuration changes
    var selectedTab by rememberSaveable { mutableStateOf(AppTab.SHOP) }
    val responsiveConfig = LocalResponsiveConfig.current

    if (responsiveConfig.showSideNav) {
        // Tablet/Desktop layout with side navigation
        Row(modifier = Modifier.fillMaxSize()) {
            SideNavigation(
                selectedTab = selectedTab,
                onTabSelected = { tab ->
                    selectedTab = tab
                },
            )

            // Content area - display selected tab screen
            when (selectedTab) {
                AppTab.SHOP -> ShopTabScreen()
                AppTab.MERCHANT -> MerchantTabScreen()
                AppTab.SETTINGS -> SettingsTabScreen()
            }
        }
    } else {
        // Mobile layout with bottom navigation
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
                AppTab.MERCHANT -> MerchantTabScreen()
                AppTab.SETTINGS -> SettingsTabScreen(Modifier.padding(padding))
            }
        }
    }
}
