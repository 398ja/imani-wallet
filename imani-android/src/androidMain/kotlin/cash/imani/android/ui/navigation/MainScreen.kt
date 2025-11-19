package cash.imani.android.ui.navigation

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import cafe.adriel.voyager.navigator.Navigator
import cafe.adriel.voyager.transitions.SlideTransition
import cash.imani.android.ui.settings.SettingsScreen
import cash.imani.app.navigation.IdentityNavHost
import cash.imani.app.navigation.VoucherListScreenNav
import cash.imani.app.ui.identity.IdentityViewModel
import cash.imani.app.ui.voucher.VoucherViewModel
import org.koin.androidx.compose.get

/**
 * Main screen with bottom navigation for Android.
 *
 * Features:
 * - Bottom navigation bar with 3 tabs
 * - Nested navigation within each tab
 * - Tab state preservation across configuration changes
 * - Smart back button handling (pops nested screens → changes tabs → exits app)
 *
 * Code Reuse:
 * - Reuses IdentityNavHost and VoucherNavHost from imani-app (100%)
 * - Material 3 navigation components (≥95% framework reuse)
 *
 * Navigation structure:
 * ```
 * MainScreen
 *  ├── Identities Tab
 *  │    └── IdentityNavHost (handles Create, Import, Detail screens)
 *  ├── Vouchers Tab
 *  │    └── VoucherNavHost (handles Issue, Redeem, Share screens)
 *  └── Settings Tab
 *       └── SettingsScreen
 * ```
 *
 * Back Button Behavior:
 * 1. If on nested screen in current tab → pop to tab's root screen
 * 2. Else if not on first tab → navigate to first tab
 * 3. Else → exit app (handled by system)
 */
@Composable
fun MainScreen() {
    var selectedIndex by rememberSaveable { mutableIntStateOf(0) }

    // Get ViewModels from Koin
    val identityViewModel: IdentityViewModel = get()
    val voucherViewModel: VoucherViewModel = get()

    // Navigation state for Identity tab (preserves state across config changes)
    val identityNavState =
        rememberSaveable(saver = IdentityNavStateSaver) {
            cash.imani.app.navigation.IdentityNavState()
        }

    val navItems =
        listOf(
            NavigationItem(
                label = "Identities",
                icon = Icons.Default.Person,
                screen = NavigationScreen.Identities,
            ),
            NavigationItem(
                label = "Vouchers",
                icon = Icons.Default.CardGiftcard,
                screen = NavigationScreen.Vouchers,
            ),
            NavigationItem(
                label = "Settings",
                icon = Icons.Default.Settings,
                screen = NavigationScreen.Settings,
            ),
        )

    Scaffold(
        bottomBar = {
            NavigationBar {
                navItems.forEachIndexed { index, item ->
                    NavigationBarItem(
                        icon = { Icon(item.icon, contentDescription = item.label) },
                        label = { Text(item.label) },
                        selected = selectedIndex == index,
                        onClick = { selectedIndex = index },
                    )
                }
            }
        },
    ) { paddingValues ->
        when (navItems[selectedIndex].screen) {
            NavigationScreen.Identities -> {
                // Smart back button: pop nested screen → go to first tab → exit
                BackHandler(enabled = identityNavState.canNavigateBack || selectedIndex != 0) {
                    when {
                        identityNavState.canNavigateBack -> identityNavState.navigateBack()
                        selectedIndex != 0 -> selectedIndex = 0
                    }
                }

                // Reuse IdentityNavHost from imani-app (100% code reuse)
                IdentityNavHost(
                    viewModel = identityViewModel,
                    navState = identityNavState,
                )
            }

            NavigationScreen.Vouchers -> {
                // Reuse VoucherNavHost with Voyager Navigator (100% code reuse)
                Navigator(VoucherListScreenNav(voucherViewModel)) { navigator ->
                    // Smart back button for Voyager-based navigation
                    BackHandler(enabled = navigator.canPop || selectedIndex != 0) {
                        when {
                            navigator.canPop -> navigator.pop()
                            selectedIndex != 0 -> selectedIndex = 0
                        }
                    }

                    SlideTransition(navigator)
                }
            }

            NavigationScreen.Settings -> {
                // Back button: go to first tab or exit
                BackHandler(enabled = selectedIndex != 0) {
                    selectedIndex = 0
                }

                // Android-specific settings screen
                SettingsScreen(modifier = Modifier.padding(paddingValues))
            }
        }
    }
}

/**
 * Navigation item for bottom navigation bar.
 */
private data class NavigationItem(
    val label: String,
    val icon: ImageVector,
    val screen: NavigationScreen,
)

/**
 * Navigation screens enum.
 */
private enum class NavigationScreen {
    Identities,
    Vouchers,
    Settings,
}
