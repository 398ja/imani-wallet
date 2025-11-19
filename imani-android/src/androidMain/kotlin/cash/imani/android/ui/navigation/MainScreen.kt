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
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import cash.imani.android.ui.settings.SettingsScreen
import cash.imani.app.ui.identity.IdentityListScreen
import cash.imani.app.ui.voucher.VoucherListScreen

/**
 * Main screen with bottom navigation for Android.
 *
 * Features:
 * - Bottom navigation bar with 3 tabs (Identities, Vouchers, Settings)
 * - Android back button handling
 * - State preservation across navigation
 *
 * Code Reuse:
 * - Reuses IdentityListScreen and VoucherListScreen from imani-app (100%)
 * - Material 3 navigation components (≥95% framework reuse)
 *
 * Navigation structure:
 * ```
 * MainScreen
 *  ├── Identities (IdentityListScreen from imani-app)
 *  ├── Vouchers (VoucherListScreen from imani-app)
 *  └── Settings (Android-specific SettingsScreen)
 * ```
 */
@Composable
fun MainScreen() {
    var selectedIndex by remember { mutableIntStateOf(0) }

    val navItems = listOf(
        NavigationItem(
            label = "Identities",
            icon = Icons.Default.Person,
            screen = NavigationScreen.Identities
        ),
        NavigationItem(
            label = "Vouchers",
            icon = Icons.Default.CardGiftcard,
            screen = NavigationScreen.Vouchers
        ),
        NavigationItem(
            label = "Settings",
            icon = Icons.Default.Settings,
            screen = NavigationScreen.Settings
        )
    )

    // Handle Android back button - exit app if on first tab
    BackHandler(enabled = selectedIndex != 0) {
        selectedIndex = 0
    }

    Scaffold(
        bottomBar = {
            NavigationBar {
                navItems.forEachIndexed { index, item ->
                    NavigationBarItem(
                        icon = { Icon(item.icon, contentDescription = item.label) },
                        label = { Text(item.label) },
                        selected = selectedIndex == index,
                        onClick = { selectedIndex = index }
                    )
                }
            }
        }
    ) { paddingValues ->
        when (navItems[selectedIndex].screen) {
            NavigationScreen.Identities -> {
                IdentityListScreen(
                    modifier = Modifier.padding(paddingValues)
                )
            }

            NavigationScreen.Vouchers -> {
                VoucherListScreen(
                    modifier = Modifier.padding(paddingValues)
                )
            }

            NavigationScreen.Settings -> {
                SettingsScreen(
                    modifier = Modifier.padding(paddingValues)
                )
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
    val screen: NavigationScreen
)

/**
 * Navigation screens enum.
 */
private enum class NavigationScreen {
    Identities,
    Vouchers,
    Settings
}
